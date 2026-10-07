#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// @ts-check
/**
 * verify-deployment: re-verifies a PayLinkV2 deployment on-chain and writes protocol/deployments/<chainId>.json.
 *
 * It runs the same code as the deploy page (web/v2/deploy/lib: core.js, rpc.js, verify.js) against the registry's
 * RPC endpoints (web/v2/deploy/data/chains.json, generated from @paylink/chains), so the record it writes is the record
 * the page printed, byte for byte, and the record `forge script script/Deploy.s.sol --sig 'record()'` writes for the
 * same deployment. Every reachable registry endpoint is asked independently; they must all agree. No key is involved:
 * the tool only reads. Usage: see USAGE below, or run it with --help.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chainOrThrow, DeployError, parseChainsData, parseReleaseData } from "../../web/v2/deploy/lib/core.js";
import { httpRpc, reader, TransportError } from "../../web/v2/deploy/lib/rpc.js";
import { verifyDeployment } from "../../web/v2/deploy/lib/verify.js";
import { getAddress, isAddress } from "../../web/v2/deploy/vendor/viem.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = resolve(REPO, "web/v2/deploy/data");

class UsageError extends Error {}

export const USAGE = `Usage: node tools/verify-deployment/verify-deployment.mjs --chain <chainId> --address <0x…> [--tx <0x…>] [options]

Re-verifies a PayLinkV2 deployment through the registry's RPC endpoints (code, masked runtime hash, CBOR metadata,
EIP-712 immutables, eip712Domain(), and with --tx the deployment transaction), then writes its record.

Options:
  --tx <hash>        deployment transaction; required to write the record (deployer, tx hash and block come from it)
  --out <path>       where to write (default protocol/deployments/<chainId>.json); "-" prints to stdout
  --compare <file>   also require the record to equal this file byte for byte (for example the page's download)
  --commit <sha>     source.commit of the record (default: the release data's sourceCommit, as the deploy page)
  --force            replace an existing record that differs (one deployment per chain: incident response only)
  --check            verify and compare with the existing record, write nothing
  --rpc <url>        a loopback endpoint (anvil) instead of the registry's, for tests and local rehearsals only
  --json             print the verification as JSON on stdout
  -h, --help         this text

Exit status: 0 verified (and written or up to date), 1 verification failed or record mismatch, 2 usage error.
`;

/**
 * @param {string[]} argv
 */
function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      chain: { type: "string" },
      address: { type: "string" },
      tx: { type: "string" },
      out: { type: "string" },
      compare: { type: "string" },
      commit: { type: "string" },
      force: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      rpc: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    return null;
  }
  if (values.chain === undefined || !/^[1-9][0-9]*$/.test(values.chain)) {
    throw new UsageError("--chain <chainId> is required (a decimal chain id)");
  }
  if (values.address === undefined || !isAddress(values.address, { strict: false })) {
    throw new UsageError("--address <0x…> is required (a 20-byte hex address)");
  }
  if (/[A-F]/.test(values.address.slice(2)) && /[a-f]/.test(values.address.slice(2)) && !isAddress(values.address, { strict: true })) {
    throw new UsageError(`--address ${values.address} has a mixed-case checksum that is wrong (EIP-55): check for a typo`);
  }
  if (values.tx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(values.tx)) {
    throw new UsageError("--tx must be 0x followed by 64 hexadecimal characters");
  }
  if (values.commit !== undefined && !/^[0-9a-f]{40}$/.test(values.commit)) {
    throw new UsageError("--commit must be a full 40-character git commit hash");
  }
  if (values.rpc !== undefined) {
    const url = new URL(values.rpc);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new UsageError("--rpc only accepts a loopback http endpoint (anvil): real chains are read through the registry's RPCs");
    }
  }
  return {
    chainId: Number(values.chain),
    address: getAddress(values.address),
    txHash: /** @type {`0x${string}` | null} */ (values.tx === undefined ? null : values.tx.toLowerCase()),
    out: values.out,
    compare: values.compare,
    commit: values.commit,
    force: values.force,
    check: values.check,
    rpc: values.rpc,
    json: values.json,
  };
}

/** @param {string} path */
const readJson = (path) => /** @type {unknown} */ (JSON.parse(readFileSync(path, "utf8")));

/**
 * @param {string[]} argv
 * @param {{ stdout: (s: string) => void; stderr: (s: string) => void }} io
 * @returns {Promise<number>}
 */
export async function main(argv, io) {
  /** @type {ReturnType<typeof options>} */
  let o;
  try {
    o = options(argv);
  } catch (error) {
    io.stderr(`verify-deployment: ${error instanceof Error ? error.message : String(error)}\n(run with --help for usage)\n`);
    return 2;
  }
  if (o === null) {
    io.stdout(USAGE);
    return 0;
  }
  const data = parseReleaseData(readJson(resolve(DATA, "release.json")));
  const chains = parseChainsData(readJson(resolve(DATA, "chains.json")));
  let chain;
  try {
    chain = chainOrThrow(chains, o.chainId);
  } catch (error) {
    io.stderr(`verify-deployment: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const endpoints = o.rpc === undefined ? chain.rpc : [o.rpc];
  /** @type {{ url: string; result: import("../../web/v2/deploy/lib/verify.js").Verification | null; error: string | null }[]} */
  const runs = [];
  for (const url of endpoints) {
    try {
      const result = await verifyDeployment({
        read: reader(httpRpc([url], { timeoutMs: 20_000 })),
        data,
        chain,
        address: o.address,
        txHash: o.txHash,
        ...(o.commit === undefined ? {} : { commit: o.commit }),
      });
      runs.push({ url, result, error: null });
    } catch (error) {
      runs.push({ url, result: null, error: error instanceof TransportError ? `unreachable (${error.message})` : error instanceof Error ? error.message : String(error) });
    }
  }
  const answered = runs.filter((r) => r.result !== null);
  const first = answered[0]?.result ?? null;

  /** @param {string} s */
  const log = (s) => {
    if (!o.json) {
      io.stderr(`${s}\n`);
    }
  };
  log(`PayLinkV2 ${data.release.release} on ${chain.name} (${String(chain.chainId)}) at ${o.address}`);
  for (const run of runs) {
    log(`  rpc ${new URL(run.url).host}: ${run.result === null ? (run.error ?? "no answer") : run.result.ok ? "verified" : "FAILED"}`);
  }
  if (first !== null) {
    for (const c of first.checks) {
      log(`  [${c.ok ? "ok" : "FAIL"}] ${c.label}: ${c.detail}`);
    }
  }

  let ok = first !== null && answered.every((r) => r.result?.ok === true);
  const records = new Set(answered.map((r) => r.result?.record ?? null));
  if (ok && records.size !== 1) {
    log("  [FAIL] the RPC endpoints disagree about this deployment");
    ok = false;
  }
  if (answered.length === 0) {
    log("  [FAIL] no registry RPC endpoint answered");
  }
  const record = ok ? (first?.record ?? null) : null;

  const outPath = o.out === "-" ? null : resolve(REPO, o.out ?? `protocol/deployments/${String(chain.chainId)}.json`);
  let status = ok ? 0 : 1;
  /** @type {string | null} */
  let action = null;
  if (ok && o.txHash === null) {
    action = "verified; pass --tx <deployment transaction> to write the record";
  } else if (record !== null) {
    if (o.compare !== undefined) {
      const expected = readFileSync(isAbsolute(o.compare) ? o.compare : resolve(process.cwd(), o.compare), "utf8");
      if (expected !== record) {
        log(`  [FAIL] ${o.compare} differs from the verified record`);
        status = 1;
      } else {
        log(`  [ok] ${o.compare} is byte-identical to the verified record`);
      }
    }
    if (outPath === null) {
      io.stdout(record);
      action = "printed";
    } else {
      const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
      const where = relative(REPO, outPath);
      if (existing === record) {
        action = `${where} is up to date`;
      } else if (o.check) {
        action = existing === null ? `${where} does not exist (--check writes nothing)` : `${where} differs from the verified record`;
        status = 1;
      } else if (existing !== null && !o.force) {
        action = `${where} already records another deployment: one deployment per chain (use --force for incident response)`;
        status = 1;
      } else if (status === 0) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, record);
        action = `wrote ${where}`;
      }
    }
  }
  if (action !== null) {
    log(`  ${action}`);
  }
  if (status === 0 && record !== null && outPath !== null && outPath === resolve(REPO, `protocol/deployments/${String(chain.chainId)}.json`)) {
    log("  next: pnpm --filter @paylink/chains run generate && pnpm --filter @paylink/deploy-page run generate");
    log(
      `        and add to docs/tools/address-allowlist.json: {"address": "${o.address}", "label": "PayLinkV2 ${data.release.release} deployment", "chainId": ${String(chain.chainId)}, "use": "registry", "confidence": "C", "source": "protocol/deployments/${String(chain.chainId)}.json"}`,
    );
  }
  if (o.json) {
    io.stdout(
      `${JSON.stringify(
        {
          chainId: chain.chainId,
          address: o.address,
          ok: status === 0 && ok,
          endpoints: runs.map((r) => ({ url: r.url, ok: r.result?.ok ?? null, error: r.error })),
          checks: first?.checks ?? [],
          action,
        },
        null,
        2,
      )}\n`,
    );
  }
  return status;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) });
  } catch (error) {
    process.stderr.write(`verify-deployment: ${error instanceof DeployError ? `${error.code}: ${error.message}` : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}
