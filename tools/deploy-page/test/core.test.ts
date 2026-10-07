// SPDX-License-Identifier: MIT
/**
 * web/v2/deploy/lib/core.js: the deploy page's and the CLI's rules, checked against their independent sources:
 * @paylink/chains (registry, deploy gas), @paylink/sdk (gas clamp, masked hash, immutables) and Foundry itself
 * (records written by Deploy.s.sol record(), test/fixtures/forge-records.json).
 */
import { readFileSync } from "node:fs";
import { deployGasFor, RELEASE, registry } from "@paylink/chains";
import { clampGasLimit as sdkClamp, expectedImmutables as sdkImmutables, maskedRuntimeHash as sdkMasked } from "@paylink/sdk";
import { concat, getCreate2Address, getCreateAddress, keccak256 } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  allPassed,
  chainOrThrow,
  clampGasLimit,
  DeployError,
  deploymentCost,
  deploymentRecordJson,
  expectedImmutables,
  explorerLinks,
  maskRuntime,
  parseChainsData,
  parseReleaseData,
  planDeployment,
  verifyCode,
  verifyDeploymentTx,
} from "../../../web/v2/deploy/lib/core.js";
import type { ChainConfig, ReleaseData, TxFacts } from "../../../web/v2/deploy/lib/core.js";

const repo = (path: string): string => new URL(`../../../${path}`, import.meta.url).pathname;
const readJson = (path: string): unknown => JSON.parse(readFileSync(repo(path), "utf8"));
const releaseJson = (): Record<string, unknown> => readJson("web/v2/deploy/data/release.json") as Record<string, unknown>;
const data: ReleaseData = parseReleaseData(releaseJson());
const chains = parseChainsData(readJson("web/v2/deploy/data/chains.json"));
const chain = (id: number): ChainConfig => chainOrThrow(chains, id);
const runtimeFixture = readJson("packages/sdk/test/fixtures/paylinkv2-runtime-31337.json") as { chainId: number; address: Address; runtimeCode: Hex; eip712DomainReturnData: Hex };
const forge = readJson("tools/deploy-page/test/fixtures/forge-records.json") as {
  records: { chainId: number; address: Address; method: "CREATE2" | "CREATE"; deployer: Address; txHash: Hex; blockNumber: number; commit: string; runtimeCode: Hex; record: string }[];
};

/** Expects a DeployError with `code`. */
function refuses(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DeployError);
    expect((error as DeployError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("release data", () => {
  it("is protocol/deployments/release.json verbatim, with the init code it locks", () => {
    expect(data.release).toEqual(readJson("protocol/deployments/release.json"));
    expect(keccak256(data.initCode)).toBe(RELEASE.initCodeHash);
    expect(getCreate2Address({ from: data.release.create2.factory, salt: data.release.create2.salt, bytecodeHash: RELEASE.initCodeHash })).toBe(RELEASE.create2.address);
  });

  it("refuses tampered init code, salt or CREATE2 address", () => {
    const base = releaseJson();
    const flip = (hex: string): string => `${hex.slice(0, -2)}${hex.endsWith("00") ? "01" : "00"}`;
    refuses(() => parseReleaseData({ ...base, initCode: flip(base["initCode"] as string) }), "E_INITCODE");
    const release = base["release"] as { create2: Record<string, string> };
    refuses(() => parseReleaseData({ ...base, release: { ...release, create2: { ...release.create2, saltPreimage: "paylink.v2.0.1" } } }), "E_DATA");
    refuses(() => parseReleaseData({ ...base, release: { ...release, create2: { ...release.create2, address: "0x5FbDB2315678afecb367f032d93F642f64180aa3" } } }), "E_DATA");
    refuses(() => parseReleaseData({ ...base, schema: "x" }), "E_DATA");
    refuses(() => parseReleaseData({ ...base, factoryRuntime: "0x" }), "E_DATA");
  });
});

describe("chain data", () => {
  it("lists exactly the three deploy targets, as the registry describes them", () => {
    expect([...chains.keys()]).toEqual([10143, 84532, 421614]);
    for (const c of chains.values()) {
      const r = registry.getOrThrow(c.chainId);
      expect(c.name).toBe(r.name);
      expect(c.rpc).toEqual(r.rpc.map((e) => e.url));
      expect(c.explorers).toEqual(r.explorers.map((e) => ({ name: e.name, url: e.url })));
      expect(c.gasModel.chargesGasLimit).toBe(r.gasModel.chargesGasLimit);
      const gas = deployGasFor(c.chainId);
      expect(c.deployGas.create).toEqual(gas?.create);
      expect(c.deployGas.create2).toEqual(gas?.create2);
      expect(c.deployment?.address ?? null).toBe(r.deployment?.address ?? null);
    }
    expect(chain(10143).gasModel.chargesGasLimit).toBe(true);
    expect(chain(84532).gasModel.chargesGasLimit).toBe(false);
  });

  it("refuses unknown chains", () => {
    for (const id of [1, 143, 5042, 31337, 31611, 8453]) {
      refuses(() => chainOrThrow(chains, id), "E_UNKNOWN_CHAIN");
    }
  });

  it("refuses non-HTTPS RPCs and duplicate chains", () => {
    const raw = readJson("web/v2/deploy/data/chains.json") as { chains: Record<string, unknown>[] };
    const [first] = raw.chains;
    expect(() => parseChainsData({ ...raw, chains: [{ ...first, rpc: ["http://testnet-rpc.monad.xyz"] }] })).toThrow(/rpc/);
    expect(() => parseChainsData({ ...raw, chains: [first, first] })).toThrow(/listed twice/);
  });
});

describe("planDeployment (Deploy.s.sol run())", () => {
  const monad = chain(10143);
  const deployer: Address = "0x0c397c6C8f94eaA6662EE548fA140e6DfEd4aEA6";
  const base = { data, chain: monad, factoryCode: data.factoryRuntime, create2Code: "0x" as Hex, recordedCode: null, deployer, nonce: 7 };

  it("deploys through the proxy with salt ++ initCode when the proxy is there", () => {
    const plan = planDeployment(base);
    expect(plan).toMatchObject({ kind: "deploy", method: "CREATE2", to: data.release.create2.factory, expectedAddress: RELEASE.create2.address, gas: monad.deployGas.create2 });
    expect(plan.kind === "deploy" ? plan.data : null).toBe(concat([data.release.create2.salt, data.initCode]));
  });

  it("only verifies when the CREATE2 address is occupied", () => {
    expect(planDeployment({ ...base, create2Code: "0x6080" })).toEqual({ kind: "verify", method: "CREATE2", address: RELEASE.create2.address, reason: "occupied" });
  });

  it("falls back to CREATE at the deployer's next address without the proxy, or when forced", () => {
    for (const plan of [planDeployment({ ...base, factoryCode: "0x" }), planDeployment({ ...base, forceCreate: true })]) {
      expect(plan).toMatchObject({ kind: "deploy", method: "CREATE", to: null, data: data.initCode, gas: monad.deployGas.create });
      expect(plan.kind === "deploy" ? plan.expectedAddress : null).toBe(getCreateAddress({ from: deployer, nonce: 7n }));
    }
  });

  it("refuses foreign code at the proxy address instead of calling it", () => {
    refuses(() => planDeployment({ ...base, factoryCode: "0x6080604052" }), "E_FACTORY_CODE");
  });

  it("verifies a recorded deployment, refuses one without code, and redeploys only when asked", () => {
    const recorded = {
      ...monad,
      deployment: { address: RELEASE.create2.address, method: "CREATE2" as const, txHash: `0x${"ab".repeat(32)}`, blockNumber: 1n, deployer, status: "active" } as const,
    };
    expect(planDeployment({ ...base, chain: recorded, recordedCode: "0x6080" })).toEqual({ kind: "verify", method: "CREATE2", address: RELEASE.create2.address, reason: "recorded" });
    refuses(() => planDeployment({ ...base, chain: recorded, recordedCode: "0x" }), "E_RECORDED_MISSING");
    expect(planDeployment({ ...base, chain: recorded, recordedCode: "0x", redeploy: true }).kind).toBe("deploy");
  });
});

describe("gas", () => {
  it("clamps exactly like @paylink/sdk clampGasLimit", () => {
    const bounds = { floor: 2_721_000n, ceiling: 4_082_000n };
    for (const estimate of [1n, 2_000_000n, 2_473_636n, 2_473_637n, 2_720_773n, 2_727_004n, 3_710_909n, 3_710_910n, 4_082_000n]) {
      expect(clampGasLimit(estimate, bounds)).toBe(sdkClamp(estimate, bounds));
    }
    expect(clampGasLimit(2_727_004n, bounds)).toBe(2_999_705n);
    refuses(() => clampGasLimit(4_082_001n, bounds), "E_GAS_ABOVE_CEILING");
    expect(() => sdkClamp(4_082_001n, bounds)).toThrow();
    refuses(() => clampGasLimit(0n, bounds), "E_ARGUMENT");
  });

  it("prices Monad by the gas limit and the others by the gas used", () => {
    const fees = { baseFee: 100_000_000_000n, priorityFee: 2_000_000_000n };
    const monad = deploymentCost({ gasLimit: 2_999_705n, estimate: 2_727_004n, ...fees, chargesGasLimit: true });
    expect(monad.expected).toBe(2_999_705n * 102_000_000_000n);
    expect(monad.maximum).toBe(2_999_705n * 202_000_000_000n);
    const base = deploymentCost({ gasLimit: 2_996_079n, estimate: 2_723_708n, baseFee: 5_000_000n, priorityFee: 1_000_000n, chargesGasLimit: false });
    expect(base.expected).toBe(2_723_708n * 6_000_000n);
  });
});

describe("code verification (PayLinkRelease._verifyDeployed)", () => {
  const f = runtimeFixture;

  it("masks like @paylink/sdk and the forge release", () => {
    const { hash, cbor } = maskRuntime(f.runtimeCode, data.release.bytecode.immutableReferences);
    expect(hash).toBe(RELEASE.maskedRuntimeHash);
    expect(hash).toBe(sdkMasked(f.runtimeCode, RELEASE.immutableReferences));
    expect(cbor).toBe(RELEASE.cborMetadata);
    // The same seven words (a multiset: the SDK sorts them, core.js keeps PayLinkRelease's order).
    expect([...expectedImmutables(f.chainId, f.address)].sort()).toEqual([...sdkImmutables(f.chainId, f.address)].sort());
  });

  it("passes the genuine deployment", () => {
    const checks = verifyCode({ data, chainId: f.chainId, address: f.address, code: f.runtimeCode, domain: f.eip712DomainReturnData });
    expect(checks.map((c) => [c.id, c.ok])).toEqual([
      ["code", true],
      ["runtime", true],
      ["metadata", true],
      ["immutables", true],
      ["domain", true],
    ]);
    expect(allPassed(checks)).toBe(true);
    expect(verifyCode({ data, chainId: f.chainId, address: f.address, code: f.runtimeCode.toUpperCase().replace("0X", "0x") as Hex, domain: f.eip712DomainReturnData }).every((c) => c.ok)).toBe(true);
  });

  it("rejects copied code (another chain or address), altered code, a wrong domain and an empty address", () => {
    const failed = (checks: { id: string; ok: boolean }[]): string[] => checks.filter((c) => !c.ok).map((c) => c.id);
    expect(failed(verifyCode({ data, chainId: 10143, address: f.address, code: f.runtimeCode, domain: f.eip712DomainReturnData }))).toEqual(["immutables", "domain"]);
    const other: Address = "0x448eCce9711860502806A3d5B021a4f9Ba715082";
    expect(failed(verifyCode({ data, chainId: f.chainId, address: other, code: f.runtimeCode, domain: f.eip712DomainReturnData }))).toEqual(["immutables", "domain"]);
    const tampered = `${f.runtimeCode.slice(0, 200)}${f.runtimeCode.slice(200, 202) === "ff" ? "00" : "ff"}${f.runtimeCode.slice(202)}` as Hex;
    expect(failed(verifyCode({ data, chainId: f.chainId, address: f.address, code: tampered, domain: f.eip712DomainReturnData }))).toEqual(["runtime"]);
    expect(failed(verifyCode({ data, chainId: f.chainId, address: f.address, code: f.runtimeCode, domain: null }))).toEqual(["domain"]);
    expect(failed(verifyCode({ data, chainId: f.chainId, address: f.address, code: "0x", domain: null }))).toEqual(["code"]);
    expect(failed(verifyCode({ data, chainId: f.chainId, address: f.address, code: "0x6000ffff", domain: null }))).toEqual(["runtime"]);
  });
});

describe("deployment transaction (Deploy.s.sol _fromBroadcast)", () => {
  const create2: TxFacts = { hash: `0x${"11".repeat(32)}`, from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", to: data.release.create2.factory, input: concat([data.release.create2.salt, data.initCode]), nonce: 0, gas: 3_000_000n, chainId: 84532 };
  const receipt = { success: true, blockNumber: 5n, contractAddress: null, gasUsed: 2_678_851n };
  const ids = (r: { checks: { id: string; ok: boolean }[] }): Record<string, boolean> => Object.fromEntries(r.checks.map((c) => [c.id, c.ok]));

  it("accepts the factory call that lands on the CREATE2 address", () => {
    const r = verifyDeploymentTx({ data, chainId: 84532, address: RELEASE.create2.address, tx: create2, receipt });
    expect(r.method).toBe("CREATE2");
    expect(allPassed(r.checks)).toBe(true);
  });

  it("rejects another chain, a failed receipt, other calldata, another target and a missing transaction", () => {
    expect(ids(verifyDeploymentTx({ data, chainId: 10143, address: RELEASE.create2.address, tx: create2, receipt }))["tx-chain"]).toBe(false);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address: RELEASE.create2.address, tx: create2, receipt: { ...receipt, success: false } }))["tx-status"]).toBe(false);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address: RELEASE.create2.address, tx: { ...create2, input: `${create2.input}00` }, receipt }))["tx-input"]).toBe(false);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", tx: create2, receipt }))["tx-address"]).toBe(false);
    const call = verifyDeploymentTx({ data, chainId: 84532, address: RELEASE.create2.address, tx: { ...create2, to: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }, receipt });
    expect(call.method).toBeNull();
    expect(allPassed(call.checks)).toBe(false);
    expect(verifyDeploymentTx({ data, chainId: 84532, address: RELEASE.create2.address, tx: null, receipt: null }).checks).toEqual([
      { id: "tx", label: "Deployment transaction", ok: false, detail: "transaction not found" },
    ]);
  });

  it("accepts a CREATE whose address follows from sender and nonce, and rejects one that does not", () => {
    const from = create2.from;
    const address = getCreateAddress({ from, nonce: 3n });
    const tx = { ...create2, to: null, input: data.initCode, nonce: 3 };
    expect(allPassed(verifyDeploymentTx({ data, chainId: 84532, address, tx, receipt: { ...receipt, contractAddress: address } }).checks)).toBe(true);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address, tx: { ...tx, nonce: 4 }, receipt: { ...receipt, contractAddress: address } }))["tx-address"]).toBe(false);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address, tx: { ...tx, input: `${data.initCode}00` }, receipt: { ...receipt, contractAddress: address } }))["tx-input"]).toBe(false);
  });
});

describe("deployment record (PayLinkRelease._deploymentJson)", () => {
  it.each(forge.records.map((r) => [r.method, r] as const))("renders forge's %s record byte for byte", (_method, r) => {
    const json = deploymentRecordJson(data, chain(r.chainId), {
      address: r.address,
      method: r.method,
      deployer: r.deployer,
      txHash: r.txHash,
      blockNumber: BigInt(r.blockNumber),
      runtimeCode: r.runtimeCode,
      commit: r.commit,
    });
    expect(json).toBe(r.record);
    expect(r.commit).toBe(data.sourceCommit);
  });

  it("refuses a non-canonical transaction hash", () => {
    const r = forge.records[0];
    if (r === undefined) {
      throw new Error("fixture missing");
    }
    refuses(
      () =>
        deploymentRecordJson(data, chain(r.chainId), {
          address: r.address,
          method: r.method,
          deployer: r.deployer,
          txHash: r.txHash.toUpperCase().replace("0X", "0x") as Hex,
          blockNumber: 1n,
          runtimeCode: r.runtimeCode,
          commit: r.commit,
        }),
      "E_ARGUMENT",
    );
  });

  it("builds explorer links in the EIP-3091 layout", () => {
    expect(explorerLinks(chain(10143), "address", RELEASE.create2.address)).toEqual([
      { name: "MonadVision", href: `https://testnet.monadvision.com/address/${RELEASE.create2.address}` },
      { name: "Monadscan", href: `https://testnet.monadscan.com/address/${RELEASE.create2.address}` },
    ]);
  });
});
