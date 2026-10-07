// SPDX-License-Identifier: MIT
/**
 * Generates the deploy page's data from the repository's sources of truth, so the page never restates an address,
 * a chain fact or a byte of bytecode by hand:
 *
 * | Output                           | Source                                                                  |
 * |----------------------------------|-------------------------------------------------------------------------|
 * | web/v2/deploy/data/chains.json   | @paylink/chains: the deploy targets, RPCs, explorers, gas model,         |
 * |                                  | measured deployment gas (deployGasFor) and recorded deployments         |
 * | web/v2/deploy/data/release.json  | protocol/deployments/release.json (verbatim), the release init code     |
 * |                                  | (protocol/out, checked against initCodeHash), the source commit, and    |
 * |                                  | the CREATE2 proxy runtime recovered from its canonical presigned tx      |
 *
 * Usage (from tools/deploy-page):  node --conditions=@paylink/source scripts/generate.ts          write
 *                                  node --conditions=@paylink/source scripts/generate.ts --check  exit 1 if stale
 *
 * `--check` needs neither `forge build` nor network: the committed init code is accepted when its keccak256 is the
 * release's initCodeHash (and, when protocol/out exists, when it equals the artifact).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployGasFor, registry } from "@paylink/chains";
import type { ChainDefinition } from "@paylink/chains";
import { getAddress, getCreateAddress, keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import type { Hex, TransactionSerialized } from "viem";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(PACKAGE_DIR, "../..");
export const DATA_DIR = join(REPO_DIR, "web/v2/deploy/data");

export const SOURCES = {
  release: "protocol/deployments/release.json",
  artifact: "protocol/out/PayLinkV2.sol/PayLinkV2.json",
  /** Paths whose last commit is the record's `source.commit`: the release lock and the sources it locks. */
  sourcePaths: ["protocol/deployments/release.json", "protocol/src"],
} as const;

/**
 * The chains the page deploys to (the task's three testnets, PAYLINK-V2-SPEC §6.4 order). Each must be an enabled
 * v2 testnet of the registry with a measured deployment gas table; anything else is refused at generation.
 */
export const DEPLOY_CHAIN_IDS: readonly number[] = [10143, 84532, 421614];

/**
 * The canonical presigned deployment of the deterministic-deployment proxy (github.com/Arachnid/deterministic-
 * deployment-proxy): a pre-EIP-155 legacy transaction, nonce 0, gas price 100 gwei, gas 100,000, r = s = 0x22…22.
 * Its signer (recovered, not trusted) is 0x3fAB…5362, whose nonce-0 CREATE address is the factory
 * 0x4e59…956C. The runtime the page expects at the factory is the code this init code returns.
 */
export const CREATE2_PROXY_PRESIGNED_TX: Hex =
  "0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222";
/** Init-code prefix of the presigned transaction: `PUSH1 0x45 DUP1 PUSH1 0x0e PUSH1 0 CODECOPY DUP1 PUSH1 0 RETURN STOP INVALID`. */
const PROXY_INIT_PREFIX = "604580600e600039806000f350fe";

export interface ProxyDeployment {
  readonly rawTransaction: Hex;
  readonly signer: `0x${string}`;
  readonly factory: `0x${string}`;
  readonly runtime: Hex;
}

/** Decodes the presigned transaction, recovers its signer and derives the factory address and runtime from it. */
export async function proxyDeployment(): Promise<ProxyDeployment> {
  const tx = parseTransaction(CREATE2_PROXY_PRESIGNED_TX);
  const data = tx.data;
  if (tx.type !== "legacy" || tx.to !== undefined || tx.nonce !== 0 || data?.startsWith(`0x${PROXY_INIT_PREFIX}`) !== true) {
    throw new Error("the presigned proxy transaction is not the canonical contract creation");
  }
  const signer = await recoverTransactionAddress({ serializedTransaction: CREATE2_PROXY_PRESIGNED_TX as TransactionSerialized });
  const runtime: Hex = `0x${data.slice(2 + PROXY_INIT_PREFIX.length)}`;
  if ((runtime.length - 2) / 2 !== 0x45) {
    throw new Error("the proxy runtime must be 69 bytes");
  }
  return { rawTransaction: CREATE2_PROXY_PRESIGNED_TX, signer, factory: getCreateAddress({ from: signer, nonce: 0n }), runtime };
}

/** `git log -1` over the release source paths: the commit whose protocol/src compiles to the locked initCodeHash. */
export function sourceCommit(repoDir: string = REPO_DIR): { commit: string; shallow: boolean } {
  const git = (...args: string[]): string => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
  const commit = git("log", "-1", "--format=%H", "--", ...SOURCES.sourcePaths);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("no commit touches the release source paths");
  }
  return { commit, shallow: git("rev-parse", "--is-shallow-repository") === "true" };
}

interface ReleaseFile {
  readonly schema: string;
  readonly contract: string;
  readonly bytecode: { readonly initCodeHash: string; readonly initCodeSize: number };
  readonly create2: { readonly factory: string; readonly address: string };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** `data/release.json`. */
export async function renderReleaseData(releaseText: string, initCode: Hex, commit: string): Promise<string> {
  const release = JSON.parse(releaseText) as ReleaseFile;
  if (release.schema !== "paylink.release/1" || release.contract !== "PayLinkV2") {
    throw new Error(`${SOURCES.release}: not a PayLinkV2 release record`);
  }
  if (keccak256(initCode) !== release.bytecode.initCodeHash || (initCode.length - 2) / 2 !== release.bytecode.initCodeSize) {
    throw new Error("the init code is not the release artifact (keccak256 or size differs from release.json): run forge build");
  }
  const proxy = await proxyDeployment();
  if (proxy.factory !== getAddress(release.create2.factory)) {
    throw new Error(`release.json names factory ${release.create2.factory}, the presigned proxy deploys ${proxy.factory}`);
  }
  return json({
    schema: "paylink.deploy-page.release/1",
    generator: "tools/deploy-page/scripts/generate.ts",
    sources: { release: SOURCES.release, initCode: SOURCES.artifact, sourceCommit: `git log -1 -- ${SOURCES.sourcePaths.join(" ")}` },
    sourceCommit: commit,
    factoryRuntime: proxy.runtime,
    release,
    initCode,
  });
}

const decimal = (value: bigint | undefined | null): string | null => (value === undefined || value === null ? null : value.toString());

function chainEntry(chain: ChainDefinition): Record<string, unknown> {
  const gas = deployGasFor(chain.chainId);
  if (chain.protocol !== "v2" || chain.status !== "enabled" || !chain.testnet || chain.local || gas === null) {
    throw new Error(`chain ${String(chain.chainId)} is not an enabled v2 testnet with a deployment gas table`);
  }
  const entry = (e: { estimate: bigint; gasUsed: bigint; floor: bigint; ceiling: bigint }): Record<string, string> => ({
    estimate: e.estimate.toString(),
    gasUsed: e.gasUsed.toString(),
    floor: e.floor.toString(),
    ceiling: e.ceiling.toString(),
  });
  const d = chain.deployment;
  return {
    chainId: chain.chainId,
    caip2: chain.caip2,
    name: chain.name,
    label: chain.label,
    tier: chain.tier,
    testnet: chain.testnet,
    nativeCurrency: chain.nativeCurrency,
    rpc: chain.rpc.map((r) => r.url),
    explorers: chain.explorers.map((e) => ({ name: e.name, url: e.url })),
    gasModel: {
      chargesGasLimit: chain.gasModel.chargesGasLimit,
      txGasCap: decimal(chain.gasModel.txGasCap),
      reserveBalance: decimal(chain.gasModel.reserveBalance),
    },
    deployGas: {
      profile: gas.profile,
      hardfork: gas.hardfork,
      network: gas.network,
      provisional: gas.provisional,
      evidence: gas.evidence,
      create: entry(gas.create),
      create2: entry(gas.create2),
    },
    deployment:
      d === null
        ? null
        : { address: d.address, method: d.method, txHash: d.txHash, blockNumber: d.blockNumber.toString(), deployer: d.deployer, status: d.status },
    notes: chain.notes,
  };
}

/** `data/chains.json`. */
export function renderChainsData(): string {
  return json({
    schema: "paylink.deploy-page.chains/1",
    generator: "tools/deploy-page/scripts/generate.ts",
    source: "@paylink/chains (packages/chains)",
    chains: DEPLOY_CHAIN_IDS.map((id) => chainEntry(registry.getOrThrow(id))),
  });
}

/** The release init code: the forge artifact when present, else the committed data (accepted only by its hash). */
export function readInitCode(repoDir: string = REPO_DIR): Hex {
  const artifactPath = join(repoDir, SOURCES.artifact);
  const committedPath = join(repoDir, "web/v2/deploy/data/release.json");
  const fromArtifact = existsSync(artifactPath) ? (JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode: { object: Hex } }).bytecode.object : null;
  const fromCommitted = existsSync(committedPath) ? (JSON.parse(readFileSync(committedPath, "utf8")) as { initCode?: Hex }).initCode ?? null : null;
  if (fromArtifact !== null && fromCommitted !== null && fromArtifact !== fromCommitted) {
    // The artifact wins; renderReleaseData then refuses it unless it is the release build.
    return fromArtifact;
  }
  const initCode = fromArtifact ?? fromCommitted;
  if (initCode === null) {
    throw new Error(`no init code: run forge build in protocol/ (${SOURCES.artifact})`);
  }
  return initCode;
}

/** Renders both files. Keys are paths relative to the repository. */
export async function renderAll(repoDir: string = REPO_DIR, commit?: string): Promise<ReadonlyMap<string, string>> {
  const releaseText = readFileSync(join(repoDir, SOURCES.release), "utf8");
  return new Map([
    ["web/v2/deploy/data/chains.json", renderChainsData()],
    ["web/v2/deploy/data/release.json", await renderReleaseData(releaseText, readInitCode(repoDir), commit ?? sourceCommit(repoDir).commit)],
  ]);
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes("--check");
  const { commit, shallow } = sourceCommit();
  let committedCommit: string | undefined;
  if (check && shallow) {
    // A shallow clone cannot see the commit that last touched the release source: keep the committed value.
    const committed = join(DATA_DIR, "release.json");
    committedCommit = existsSync(committed) ? (JSON.parse(readFileSync(committed, "utf8")) as { sourceCommit: string }).sourceCommit : undefined;
    console.warn("shallow clone: sourceCommit is not re-derived");
  }
  let stale = 0;
  for (const [relativePath, content] of await renderAll(REPO_DIR, committedCommit ?? commit)) {
    const path = join(REPO_DIR, relativePath);
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current === content) {
      continue;
    }
    if (check) {
      stale += 1;
      console.error(`stale: ${relativePath} (run: pnpm --filter @paylink/deploy-page run generate)`);
    } else {
      writeFileSync(path, content);
      console.log(`wrote ${relative(REPO_DIR, path)}`);
    }
  }
  return stale === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
