// SPDX-License-Identifier: MIT
/**
 * The generated files must equal what the generator renders from the protocol's records today (drift check),
 * and the generator must refuse records that do not describe the audited release.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseDeploymentRecord,
  parseRelease,
  parseV1Config,
  renderAll,
  renderDeployments,
  renderGas,
  renderRelease,
  renderV1,
  SOURCES,
} from "../scripts/generate.ts";
import { deploymentFromRecord, DEPLOYMENT_RECORDS, RELEASE, registry, V1_CONFIG } from "../src/index.ts";
import type { DeploymentRecord as GeneratedRecord } from "../src/index.ts";

const repo = (relative: string): string => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
const packageFile = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const releaseText = readFileSync(repo(SOURCES.release), "utf8");
const release = parseRelease(releaseText);

describe("drift", () => {
  it.each([...renderAll(repo(""))])("%s is up to date (run: pnpm --filter @paylink/chains run generate)", (relative, content) => {
    expect(readFileSync(packageFile(relative), "utf8")).toBe(content);
  });

  it("generated values reach the public API", () => {
    expect(RELEASE.initCodeHash).toBe(release.bytecode.initCodeHash);
    expect(RELEASE.maskedRuntimeHash).toBe(release.bytecode.maskedRuntimeHash);
    expect(RELEASE.immutableReferences).toHaveLength(7);
    expect(V1_CONFIG.chainId).toBe(5042);
    expect(DEPLOYMENT_RECORDS).toEqual({});
  });

  it("renders the measured snapshot deterministically", () => {
    const text = readFileSync(repo(SOURCES.gasSnapshot), "utf8");
    const measured = readFileSync(repo(SOURCES.gasMeasurements), "utf8");
    const rendered = renderGas(text, measured, release.bytecode.initCodeHash);
    expect(renderGas(text, measured, release.bytecode.initCodeHash)).toBe(rendered);
    expect(rendered).toContain("payWithAuthorization: { floor: 143_000n, ceiling: 215_000n },");
    expect(rendered).toContain("payWithAuthorization: { floor: 224_000n, ceiling: 336_000n },");
  });
});

/** A deployment record as Deploy.s.sol `record()` writes it (protocol/deployments/README.md). */
function recordJson(patch: (r: Record<string, unknown>) => void = () => undefined): string {
  const address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const txHash = `0x${"ab".repeat(32)}`;
  const r: Record<string, unknown> = {
    schema: "paylink.deployment/1",
    contract: "PayLinkV2",
    release: release.release,
    chainId: 84532,
    caip2: "eip155:84532",
    network: "Base Sepolia",
    address,
    caip10: `eip155:84532:${address}`,
    deployment: {
      method: "CREATE2",
      deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      txHash,
      blockNumber: 12345,
      factory: release.create2.factory,
      salt: release.create2.salt,
      saltPreimage: release.create2.saltPreimage,
    },
    bytecode: {
      initCodeHash: release.bytecode.initCodeHash,
      maskedRuntimeHash: release.bytecode.maskedRuntimeHash,
      runtimeCodeHash: `0x${"cd".repeat(32)}`,
      runtimeCodeSize: release.bytecode.runtimeCodeSize,
    },
    eip712Domain: { name: "PayLink", version: "2", chainId: 84532, verifyingContract: address },
    explorers: [
      { name: "Basescan", address: `https://sepolia.basescan.org/address/${address}`, tx: `https://sepolia.basescan.org/tx/${txHash}` },
      { name: "Blockscout", address: `https://base-sepolia.blockscout.com/address/${address}`, tx: `https://base-sepolia.blockscout.com/tx/${txHash}` },
    ],
  };
  patch(r);
  return JSON.stringify(r);
}

const sub = (r: Record<string, unknown>, key: string): Record<string, unknown> => r[key] as Record<string, unknown>;

describe("deployment records", () => {
  it("parses a CREATE2 record and renders it", () => {
    const record = parseDeploymentRecord(recordJson(), 84532, release);
    expect(record).toMatchObject({ chainId: 84532, method: "CREATE2", blockNumber: 12345n, network: "Base Sepolia" });
    expect(record.explorers.map((e) => e.origin)).toEqual(["https://sepolia.basescan.org", "https://base-sepolia.blockscout.com"]);
    const rendered = renderDeployments([record, { ...record, chainId: 10143, network: "Monad testnet" }]);
    expect(rendered).toContain("  10143: {");
    expect(rendered.indexOf("10143: {")).toBeLessThan(rendered.indexOf("84532: {"));
    expect(rendered).toContain("blockNumber: 12345n,");
  });

  it("parses a CREATE record with null CREATE2 fields", () => {
    const text = recordJson((r) => {
      Object.assign(sub(r, "deployment"), { method: "CREATE", factory: null, salt: null, saltPreimage: null });
    });
    expect(parseDeploymentRecord(text, 84532, release).method).toBe("CREATE");
  });

  it.each<[string, (r: Record<string, unknown>) => void, RegExp]>([
    ["schema", (r) => (r["schema"] = "paylink.deployment/0"), /schema/],
    ["contract", (r) => (r["contract"] = "PayLink"), /contract must be PayLinkV2/],
    ["release", (r) => (r["release"] = "1.0.0"), /release 1.0.0 is not/],
    ["chainId", (r) => (r["chainId"] = 10143), /chainId does not match/],
    ["caip2", (r) => (r["caip2"] = "eip155:1"), /caip2 mismatch/],
    ["address case", (r) => (r["address"] = "0x5fbdb2315678afecb367f032d93f642f64180aa3"), /not EIP-55/],
    ["address", (r) => (r["address"] = "0x5FbDB2315678"), /not an address/],
    ["caip10", (r) => (r["caip10"] = "eip155:84532:0x0"), /caip10 mismatch/],
    ["network", (r) => (r["network"] = ""), /network missing/],
    ["method", (r) => (sub(r, "deployment")["method"] = "CALL"), /deployment.method/],
    ["txHash", (r) => (sub(r, "deployment")["txHash"] = "0xAB"), /txHash: not a lowercase bytes32/],
    ["blockNumber", (r) => (sub(r, "deployment")["blockNumber"] = -1), /blockNumber/],
    ["blockNumber type", (r) => (sub(r, "deployment")["blockNumber"] = "1"), /blockNumber/],
    ["salt", (r) => (sub(r, "deployment")["salt"] = `0x${"00".repeat(32)}`), /CREATE2 parameters differ/],
    ["CREATE fields", (r) => (sub(r, "deployment")["method"] = "CREATE"), /CREATE records carry null CREATE2 fields/],
    ["initCodeHash", (r) => (sub(r, "bytecode")["initCodeHash"] = `0x${"00".repeat(32)}`), /initCodeHash is not the release/],
    ["maskedRuntimeHash", (r) => (sub(r, "bytecode")["maskedRuntimeHash"] = `0x${"00".repeat(32)}`), /maskedRuntimeHash is not the release/],
    ["domain", (r) => (sub(r, "eip712Domain")["version"] = "1"), /eip712Domain does not match/],
    ["explorer entry", (r) => (r["explorers"] = [{ name: 1 }]), /explorer entry/],
    ["explorer link", (r) => (r["explorers"] = [{ name: "x", address: "http://sepolia.basescan.org/address/0x0" }]), /explorer link/],
  ])("refuses a record with a bad %s", (_what, patch, pattern) => {
    expect(() => parseDeploymentRecord(recordJson(patch), 84532, release)).toThrow(pattern);
  });

  it("applies the lifecycle status (default active)", () => {
    const parsed = parseDeploymentRecord(recordJson(), 84532, release);
    const generated: GeneratedRecord = parsed;
    expect(deploymentFromRecord(undefined, undefined)).toBeNull();
    expect(deploymentFromRecord(generated, undefined)?.status).toBe("active");
    const revoked = deploymentFromRecord(generated, "revoked");
    expect(revoked).toEqual({
      address: parsed.address,
      status: "revoked",
      release: "2.0.0",
      method: "CREATE2",
      deployer: parsed.deployer,
      txHash: parsed.txHash,
      blockNumber: 12345n,
      initCodeHash: release.bytecode.initCodeHash,
      maskedRuntimeHash: release.bytecode.maskedRuntimeHash,
      runtimeCodeHash: `0x${"cd".repeat(32)}`,
    });
  });
});

describe("release.json", () => {
  const mutate = (patch: (r: Record<string, unknown>) => void): string => {
    const r = JSON.parse(releaseText) as Record<string, unknown>;
    patch(r);
    return JSON.stringify(r);
  };

  it("renders every field", () => {
    const text = renderRelease(releaseText);
    expect(text).toContain(`initCodeHash: "${release.bytecode.initCodeHash}"`);
    expect(text).toContain('openZeppelin: "5.3.0"');
  });

  it.each<[string, (r: Record<string, unknown>) => void, RegExp]>([
    ["schema", (r) => (r["schema"] = "x"), /schema must be paylink.release\/1/],
    ["contract", (r) => (r["contract"] = "x"), /contract must be PayLinkV2/],
    ["release", (r) => (r["release"] = "v2"), /release must be semver/],
    ["initCodeHash", (r) => (sub(r, "bytecode")["initCodeHash"] = "0x00"), /initCodeHash: not a lowercase bytes32/],
    ["factory", (r) => (sub(r, "create2")["factory"] = "0x4e59b44847b379578588920ca78fbf26c0b4956c"), /factory: .* not EIP-55/],
    ["cbor", (r) => (sub(r, "bytecode")["cborMetadata"] = "a264"), /cborMetadata/],
    ["immutable", (r) => (sub(r, "bytecode")["immutableReferences"] = [{ start: 1, length: 31 }]), /bad immutable reference/],
  ])("refuses a bad %s", (_what, patch, pattern) => {
    expect(() => parseRelease(mutate(patch))).toThrow(pattern);
  });
});

describe("web/config.js (v1)", () => {
  const config = (body: string): string => `// comment\nwindow.PAYLINK_CONFIG = ${body};\n`;

  it("reads the frozen v1 config, including a deployed address", () => {
    const text = config('{"network": "mainnet", "chainId": 5042, "rpc": "https://rpc.mainnet.arc.io", "explorer": null, "address": "0x5FbDB2315678afecb367f032d93F642f64180aa3"}');
    expect(parseV1Config(text)).toEqual({
      network: "mainnet",
      chainId: 5042,
      rpc: "https://rpc.mainnet.arc.io",
      explorer: null,
      address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    });
    expect(renderV1(text)).toContain('address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",');
  });

  it.each([
    ["missing", "window.OTHER = {};", /not found/],
    ["chainId", config('{"network": "m", "chainId": "5042", "rpc": "https://a", "explorer": null, "address": null}'), /chainId/],
    ["network", config('{"network": 1, "chainId": 5042, "rpc": "https://a", "explorer": null, "address": null}'), /network/],
    ["rpc", config('{"network": "m", "chainId": 5042, "rpc": "http://a", "explorer": null, "address": null}'), /rpc must be https/],
    ["explorer", config('{"network": "m", "chainId": 5042, "rpc": "https://a", "explorer": "ftp://x", "address": null}'), /explorer/],
    ["address", config('{"network": "m", "chainId": 5042, "rpc": "https://a", "explorer": null, "address": "0x5fbdb2315678afecb367f032d93f642f64180aa3"}'), /not EIP-55/],
  ])("refuses a bad %s", (_what, text, pattern) => {
    expect(() => parseV1Config(text)).toThrow(pattern);
  });
});

/**
 * The deploy scripts write chain names and explorer links into every record from their own table
 * (protocol/script/utils/PayLinkRelease.sol `_network`). It must agree with the registry, or records and
 * the web app would link to different explorers.
 */
describe("parity with the deploy scripts' network table", () => {
  const solidity = readFileSync(repo("protocol/script/utils/PayLinkRelease.sol"), "utf8");
  const table = new Map<number, { name: string; urls: string[] }>();
  for (const block of solidity.matchAll(/chainId == ([\d_]+)\) \{([\s\S]*?)\}/g)) {
    const chainId = Number((block[1] ?? "").replaceAll("_", ""));
    const body = block[2] ?? "";
    const name = /name = "([^"]+)"/.exec(body)?.[1] ?? "";
    const urlsCall = /explorerUrls = _(?:pair|one)\(([^)]*)\)/.exec(body)?.[1] ?? "";
    table.set(chainId, { name, urls: [...urlsCall.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "") });
  }

  it("parses the table", () => {
    expect(table.size).toBeGreaterThanOrEqual(6);
  });

  it.each(registry.chains.map((c) => [c.chainId, c] as const))("chain %i has the same name and explorers", (chainId, chain) => {
    const entry = table.get(chainId);
    expect(entry, `chain ${chainId} missing from PayLinkRelease.sol`).toBeDefined();
    expect(entry?.name).toBe(chain.name);
    expect(entry?.urls).toEqual(chain.explorers.map((e) => e.url));
  });
});
