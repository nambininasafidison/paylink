// SPDX-License-Identifier: MIT
/**
 * web/v2/deploy/lib/core.js: the deploy page's and the CLI's rules, checked against their independent sources:
 * @paylink/chains (registry, deploy gas), @paylink/sdk (gas clamp, masked hash, immutables) and Foundry itself
 * (records written by Deploy.s.sol record(), test/fixtures/forge-records.json).
 */
import { readFileSync } from "node:fs";
import { deployGasFor, RELEASE, registry } from "@paylink/chains";
import { clampGasLimit as sdkClamp, expectedImmutables as sdkImmutables, maskedRuntimeHash as sdkMasked } from "@paylink/sdk";
import { readdirSync } from "node:fs";
import { concat, getCreate2Address, getCreateAddress, keccak256, padHex } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  allPassed,
  authorityCandidates,
  byteOffset,
  chainOrThrow,
  clampGasLimit,
  create2InTrace,
  DeployError,
  deploymentCost,
  deploymentRecordJson,
  deploymentRoute,
  expectedImmutables,
  explorerLinks,
  maskRuntime,
  parseChainsData,
  parseReleaseData,
  planDeployment,
  verifyCode,
  verifyDeploymentTx,
} from "../../../web/v2/deploy/lib/core.js";
import type { ChainConfig, RelayEvidence, ReleaseData, TxFacts } from "../../../web/v2/deploy/lib/core.js";

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
  // The planning rules on a chain with no record yet (Monad testnet's own record is exercised below and in
  // "plans the shipped Monad record as a verification").
  const monad = { ...chain(10143), deployment: null };
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

  it("plans the shipped Monad testnet record (protocol/deployments/10143.json) as a verification", () => {
    const shipped = chain(10143);
    expect(shipped.deployment).toMatchObject({ address: RELEASE.create2.address, method: "CREATE2", status: "active" });
    expect(planDeployment({ ...base, chain: shipped, recordedCode: "0x6080" })).toEqual({ kind: "verify", method: "CREATE2", address: RELEASE.create2.address, reason: "recorded" });
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

const CREATE2_ADDRESS = RELEASE.create2.address;
const FACTORY = data.release.create2.factory;
const PAYLOAD = concat([data.release.create2.salt, data.initCode]);
const ids = (r: { checks: { id: string; ok: boolean }[] }): Record<string, boolean> => Object.fromEntries(r.checks.map((c) => [c.id, c.ok]));

describe("deployment transaction, direct route (Deploy.s.sol _fromBroadcast)", () => {
  const create2: TxFacts = { hash: `0x${"11".repeat(32)}`, from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", to: FACTORY, input: PAYLOAD, nonce: 0, gas: 3_000_000n, chainId: 84532, type: 2, authorizationList: null };
  const receipt = { success: true, blockNumber: 5n, contractAddress: null, gasUsed: 2_678_851n };

  it("accepts the factory call that lands on the CREATE2 address, with the sender as deployer", () => {
    const r = verifyDeploymentTx({ data, chainId: 84532, address: CREATE2_ADDRESS, tx: create2, receipt });
    expect(r).toMatchObject({ method: "CREATE2", route: "direct", deployer: create2.from, submitter: create2.from, authorization: null });
    expect(r.checks.map((c) => c.id)).toEqual(["tx-chain", "tx-status", "tx-input", "tx-address"]);
    expect(allPassed(r.checks)).toBe(true);
    expect(deploymentRoute(data, create2)).toBe("direct");
  });

  it("rejects another chain, a failed receipt, other calldata or init code, another target and a missing transaction", () => {
    expect(ids(verifyDeploymentTx({ data, chainId: 10143, address: CREATE2_ADDRESS, tx: create2, receipt }))["tx-chain"]).toBe(false);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address: CREATE2_ADDRESS, tx: create2, receipt: { ...receipt, success: false } }))["tx-status"]).toBe(false);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address: CREATE2_ADDRESS, tx: { ...create2, input: `${create2.input}00` }, receipt }))["tx-input"]).toBe(false);
    // The direct route stays exact: the payload inside a longer factory call is not accepted as "contained".
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address: CREATE2_ADDRESS, tx: { ...create2, input: concat(["0x00", PAYLOAD]) }, receipt }))["tx-input"]).toBe(false);
    const wrongInit = concat([data.release.create2.salt, `${data.initCode.slice(0, -2)}${data.initCode.endsWith("00") ? "01" : "00"}` as Hex]);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address: CREATE2_ADDRESS, tx: { ...create2, input: wrongInit }, receipt }))["tx-input"]).toBe(false);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", tx: create2, receipt }))["tx-address"]).toBe(false);
    const call = verifyDeploymentTx({ data, chainId: 84532, address: CREATE2_ADDRESS, tx: { ...create2, to: "0x5FbDB2315678afecb367f032d93F642f64180aa3", input: "0x12345678" }, receipt });
    expect(call).toMatchObject({ method: null, route: null, deployer: null });
    expect(call.checks.at(-1)).toMatchObject({ id: "tx-input", label: "Deployment transaction", ok: false });
    expect(allPassed(call.checks)).toBe(false);
    expect(verifyDeploymentTx({ data, chainId: 84532, address: CREATE2_ADDRESS, tx: null, receipt: null }).checks).toEqual([
      { id: "tx", label: "Deployment transaction", ok: false, detail: "transaction not found" },
    ]);
  });

  it("accepts a CREATE whose address follows from sender and nonce, and rejects one that does not", () => {
    const from = create2.from;
    const address = getCreateAddress({ from, nonce: 3n });
    const tx = { ...create2, to: null, input: data.initCode, nonce: 3 };
    const r = verifyDeploymentTx({ data, chainId: 84532, address, tx, receipt: { ...receipt, contractAddress: address } });
    expect(r).toMatchObject({ method: "CREATE", route: "direct", deployer: from });
    expect(allPassed(r.checks)).toBe(true);
    expect(deploymentRoute(data, tx)).toBe("direct");
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address, tx: { ...tx, nonce: 4 }, receipt: { ...receipt, contractAddress: address } }))["tx-address"]).toBe(false);
    expect(ids(verifyDeploymentTx({ data, chainId: 84532, address, tx: { ...tx, input: `${data.initCode}00` }, receipt: { ...receipt, contractAddress: address } }))["tx-input"]).toBe(false);
  });
});

describe("deployment transaction, relayed route (smart account, EIP-7702)", () => {
  // The shape of tx 0x2969…b5ed on Base Sepolia: MetaMask's relayer sends a type-4 transaction to the delegation manager,
  // carrying the user's authorization (delegate 0x63c0…) and, inside its input, the user's account as an ABI word and
  // the factory call packed as target ‖ value ‖ salt ‖ initCode.
  const USER: Address = "0x0c397c6c8F94EAA6662eE548fA140e6DfEd4aea6";
  const RELAYER: Address = "0xC066ac5D385419B1A8c43A0E146fA439837a8B8c";
  const MANAGER: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
  const DELEGATE: Address = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
  const AUTHORIZATION = {
    chainId: 84532n,
    address: DELEGATE,
    nonce: 0n,
    yParity: 0,
    r: 0x3fca8aff26ea0f1251afc940e234c777342b93fcfb4a5d51c728bfea7715b09n,
    s: 0x228ddefc70eddfdf68e5d2b444012c605ee2c52ed14e0ea712f0659c9a4fbbc7n,
  };
  const BLOCK = 47_859_253n;
  const input = concat(["0xcef6d209", padHex(USER, { size: 32 }), FACTORY, padHex("0x00", { size: 32 }), PAYLOAD, padHex("0x00", { size: 23 })]);
  const relayed: TxFacts = { hash: "0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed", from: RELAYER, to: MANAGER, input, nonce: 123_173, gas: 3_623_648n, chainId: 84532, type: 4, authorizationList: [AUTHORIZATION] };
  const receipt = { success: true, blockNumber: BLOCK, contractAddress: null, gasUsed: 3_260_830n };
  const designator = `0xef0100${DELEGATE.slice(2).toLowerCase()}` as Hex;
  const evidence: RelayEvidence = {
    before: { block: BLOCK - 1n, code: "0x", error: null },
    after: { block: BLOCK, code: "0x6080604052", error: null },
    trace: { source: null, result: null, errors: ["debug_traceTransaction: rejected due to request filter settings"] },
    authorities: { [USER]: { block: BLOCK, code: designator, error: null } },
  };
  const check = (tx: TxFacts, relay: RelayEvidence | null, rcpt = receipt, address: Address = CREATE2_ADDRESS) => verifyDeploymentTx({ data, chainId: 84532, address, tx, receipt: rcpt, relay });
  const failed = (r: { checks: { id: string; ok: boolean }[] }): string[] => r.checks.filter((c) => !c.ok).map((c) => c.id);

  /** geth callTracer: relayer → manager → user (delegated) → factory → CREATE2. */
  const callTrace = ({ userError, createTo = CREATE2_ADDRESS, factoryInput = PAYLOAD }: { userError?: string; createTo?: Address; factoryInput?: Hex } = {}): unknown => ({
    type: "CALL",
    from: RELAYER.toLowerCase(),
    to: MANAGER.toLowerCase(),
    input,
    calls: [
      {
        type: "CALL",
        from: MANAGER.toLowerCase(),
        to: USER.toLowerCase(),
        input: "0x",
        ...(userError === undefined ? {} : { error: userError }),
        calls: [
          {
            type: "CALL",
            from: USER.toLowerCase(),
            to: FACTORY.toLowerCase(),
            input: factoryInput,
            calls: [{ type: "CREATE2", from: FACTORY.toLowerCase(), to: createTo.toLowerCase(), input: data.initCode }],
          },
        ],
      },
    ],
  });
  /** parity/erigon trace_transaction of the same transaction. */
  const parityTrace = (userError?: string): unknown[] => [
    { type: "call", traceAddress: [], action: { callType: "call", from: RELAYER, to: MANAGER, input } },
    { type: "call", traceAddress: [0], action: { callType: "call", from: MANAGER, to: USER, input: "0x" }, ...(userError === undefined ? {} : { error: userError }) },
    { type: "call", traceAddress: [0, 0], action: { callType: "call", from: USER, to: FACTORY, input: PAYLOAD } },
    { type: "create", traceAddress: [0, 0, 0], action: { from: FACTORY, init: data.initCode, creationMethod: "create2" }, result: { address: CREATE2_ADDRESS } },
  ];

  it("finds the payload byte-aligned inside the input, and the authority it names", () => {
    expect(deploymentRoute(data, relayed)).toBe("relayed");
    expect(byteOffset(input, PAYLOAD)).toBe(4 + 32 + 20 + 32);
    expect(byteOffset("0x0abc", "0xbc")).toBe(1);
    expect(byteOffset("0xabcd", "0xbc")).toBe(-1);
    expect(authorityCandidates(relayed, 84532)).toEqual([USER]);
    expect(authorityCandidates({ ...relayed, input: concat(["0xcef6d209", PAYLOAD]) }, 84532)).toEqual([]);
    expect(authorityCandidates({ ...relayed, to: USER, input: PAYLOAD }, 84532)).toEqual([USER]);
  });

  it("accepts the factory call reached inside a relayed transaction, with the user's account as deployer", () => {
    const r = check(relayed, evidence);
    expect(failed(r)).toEqual([]);
    expect(r).toMatchObject({ method: "CREATE2", route: "relayed", deployer: USER, submitter: RELAYER });
    expect(r.authorization).toEqual([{ chainId: 84532n, address: DELEGATE, nonce: 0n, authority: USER }]);
    expect(r.checks.map((c) => c.id)).toEqual(["tx-chain", "tx-status", "tx-route", "tx-input", "tx-address", "tx-created", "tx-deployer"]);
    expect(r.checks.find((c) => c.id === "tx-created")?.detail).toBe(`no code at block ${String(BLOCK - 1n)}, code at block ${String(BLOCK)} (historical eth_getCode)`);
    expect(r.checks.find((c) => c.id === "tx-deployer")?.detail).toContain(`${USER}: signed this transaction's EIP-7702 authorization`);
  });

  it("rejects a relayed transaction whose input does not carry the factory call", () => {
    for (const other of [concat(["0xcef6d209", padHex(USER, { size: 32 })]), concat([FACTORY, data.release.create2.salt]), PAYLOAD.slice(0, -2) as Hex]) {
      const r = check({ ...relayed, input: other }, evidence);
      expect(r).toMatchObject({ method: null, route: null, deployer: null });
      expect(failed(r)).toEqual(["tx-input"]);
    }
    // The payload must start on a byte boundary: shifted by one nibble it is not the factory call.
    const shifted = `0x0${PAYLOAD.slice(2)}0` as Hex;
    expect(deploymentRoute(data, { ...relayed, input: shifted })).toBeNull();
  });

  it("rejects wrong init code or another salt inside the relayed call", () => {
    const flipped = `${data.initCode.slice(0, -2)}${data.initCode.endsWith("00") ? "01" : "00"}` as Hex;
    const wrongInit = concat(["0xcef6d209", padHex(USER, { size: 32 }), FACTORY, padHex("0x00", { size: 32 }), data.release.create2.salt, flipped]);
    const otherSalt = concat(["0xcef6d209", padHex(USER, { size: 32 }), FACTORY, padHex("0x00", { size: 32 }), keccak256("0x01"), data.initCode]);
    for (const bad of [wrongInit, otherSalt]) {
      const r = check({ ...relayed, input: bad }, evidence);
      expect(r.method).toBeNull();
      expect(failed(r)).toEqual(["tx-input"]);
    }
  });

  it("rejects a relayed transaction when the code was already there before its block", () => {
    const r = check(relayed, { ...evidence, before: { block: BLOCK - 1n, code: "0x6080604052", error: null } });
    expect(failed(r)).toEqual(["tx-created"]);
    expect(r.checks.find((c) => c.id === "tx-created")?.detail).toContain("this transaction did not create it");
  });

  it("rejects a relayed transaction that left no code at its block (a swallowed inner revert), or failed", () => {
    expect(failed(check(relayed, { ...evidence, after: { block: BLOCK, code: "0x", error: null } }))).toEqual(["tx-created"]);
    expect(failed(check(relayed, evidence, { ...receipt, success: false }))).toEqual(["tx-status"]);
    expect(failed(check({ ...relayed, chainId: 10143 }, evidence))).toEqual(["tx-chain"]);
    expect(failed(check(relayed, evidence, receipt, "0x5FbDB2315678afecb367f032d93F642f64180aa3"))).toEqual(["tx-address"]);
  });

  it("refuses the relayed route without state evidence, or with evidence for other blocks", () => {
    expect(failed(check(relayed, null))).toEqual(["tx-created"]);
    expect(failed(check(relayed, { ...evidence, before: { block: BLOCK - 2n, code: "0x", error: null } }))).toEqual(["tx-created"]);
    expect(failed(check(relayed, { ...evidence, after: { block: BLOCK + 1n, code: "0x6080", error: null } }))).toEqual(["tx-created"]);
  });

  it("without archive state, accepts on the evidence the RPC still serves and says so", () => {
    const r = check(relayed, {
      ...evidence,
      before: { block: BLOCK - 1n, code: null, error: "missing trie node" },
      after: { block: "latest", code: "0x6080604052", error: "missing trie node" },
      authorities: { [USER]: { block: "latest", code: designator, error: "missing trie node" } },
    });
    expect(failed(r)).toEqual([]);
    expect(r.deployer).toBe(USER);
    expect(r.checks.find((c) => c.id === "tx-created")?.detail).toBe(`code at the latest block; absence at block ${String(BLOCK - 1n)} not proven, the RPC serves no state there (missing trie node)`);
  });

  it("confirms the CREATE2 with a trace (callTracer or trace_transaction) and takes the deployer from it", () => {
    for (const result of [callTrace(), parityTrace()]) {
      const r = check({ ...relayed, type: 2, authorizationList: null }, { ...evidence, authorities: {}, trace: { source: "debug_traceTransaction (callTracer)", result, errors: [] } });
      expect(failed(r)).toEqual([]);
      expect(r.checks.map((c) => c.id)).toContain("tx-trace");
      expect(r.deployer).toBe(USER);
      expect(create2InTrace(result, { factory: FACTORY, address: CREATE2_ADDRESS, initCode: data.initCode, payload: PAYLOAD })).toEqual({ caller: USER });
    }
  });

  it("rejects a trace that does not show a standing CREATE2 of the release by the factory", () => {
    const expected = { factory: FACTORY, address: CREATE2_ADDRESS, initCode: data.initCode, payload: PAYLOAD };
    for (const result of [callTrace({ userError: "execution reverted" }), callTrace({ createTo: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }), callTrace({ factoryInput: data.initCode }), parityTrace("Reverted"), [], {}]) {
      expect(create2InTrace(result, expected)).toBeNull();
      const r = check(relayed, { ...evidence, trace: { source: "trace", result, errors: [] } });
      expect(failed(r)).toEqual(["tx-trace"]);
    }
  });

  it("records a null deployer, and says why, when no authority qualifies and no trace is served", () => {
    const why = (r: { checks: { id: string; detail: string }[] }): string => r.checks.find((c) => c.id === "tx-deployer")?.detail ?? "";
    // A relayed call without an authorization list (an ERC-4337 account, or an account delegated earlier).
    const plain = check({ ...relayed, type: 2, authorizationList: null }, { ...evidence, authorities: {} });
    expect(failed(plain)).toEqual([]);
    expect(plain).toMatchObject({ deployer: null, authorization: null, route: "relayed" });
    expect(why(plain)).toContain("no EIP-7702 authorization");
    // The authority is not delegated to the authorization's address at the block.
    const elsewhere = check(relayed, { ...evidence, authorities: { [USER]: { block: BLOCK, code: "0x", error: null } } });
    expect(elsewhere.deployer).toBeNull();
    expect(why(elsewhere)).toContain("recorded as null");
    // The authority is not named by the transaction.
    const unnamed = check({ ...relayed, input: concat(["0xcef6d209", PAYLOAD]) }, evidence);
    expect(unnamed.deployer).toBeNull();
    // An authorization for another chain has no authority.
    const foreign = check({ ...relayed, authorizationList: [{ ...AUTHORIZATION, chainId: 10143n }] }, evidence);
    expect(foreign.deployer).toBeNull();
    expect(foreign.authorization).toEqual([{ chainId: 10143n, address: DELEGATE, nonce: 0n, authority: null }]);
  });

  it("writes route, submitter and authorization after the forge keys of a relayed record", () => {
    const facts = { address: CREATE2_ADDRESS, method: "CREATE2" as const, txHash: relayed.hash, blockNumber: BLOCK, runtimeCode: "0x6080604052" as Hex, commit: data.sourceCommit };
    const json = deploymentRecordJson(data, chain(84532), { ...facts, deployer: USER, relayed: { submitter: RELAYER, authorization: [{ chainId: 84532n, address: DELEGATE, nonce: 0n, authority: USER }] } });
    expect(json).toContain(
      [
        `    "saltPreimage": "paylink.v2.0.0",`,
        `    "route": "relayed",`,
        `    "submitter": "${RELAYER}",`,
        `    "authorization": [`,
        `      {"chainId": 84532, "address": "${DELEGATE}", "nonce": 0, "authority": "${USER}"}`,
        `    ]`,
        `  },`,
      ].join("\n"),
    );
    expect(JSON.parse(json)).toMatchObject({ deployment: { method: "CREATE2", deployer: USER, route: "relayed", submitter: RELAYER } });
    const unknown = deploymentRecordJson(data, chain(84532), { ...facts, deployer: null, relayed: { submitter: RELAYER, authorization: null } });
    expect(unknown).toContain(`    "deployer": null,\n`);
    expect(unknown).toContain(`    "authorization": null\n  },`);
    refuses(() => deploymentRecordJson(data, chain(84532), { ...facts, deployer: null }), "E_ARGUMENT");
    refuses(() => deploymentRecordJson(data, chain(84532), { ...facts, method: "CREATE", deployer: USER, relayed: { submitter: RELAYER, authorization: null } }), "E_ARGUMENT");
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

  /** PayLinkV2's runtime at `address` on `chainId`: the 31337 fixture with its seven immutables rebound. */
  function runtimeFor(chainId: number, address: Address): Hex {
    const from = expectedImmutables(runtimeFixture.chainId, runtimeFixture.address);
    const to = expectedImmutables(chainId, address);
    let code = runtimeFixture.runtimeCode.toLowerCase();
    for (const ref of data.release.bytecode.immutableReferences) {
      const at = 2 + ref.start * 2;
      const index = from.indexOf(`0x${code.slice(at, at + 64)}`);
      expect(index).toBeGreaterThanOrEqual(0);
      code = `${code.slice(0, at)}${(to[index] ?? "").slice(2)}${code.slice(at + 64)}`;
    }
    return code as Hex;
  }

  const shipped = readdirSync(repo("protocol/deployments")).filter((name) => /^[1-9][0-9]*\.json$/.test(name));
  it.each(shipped)("re-renders the shipped record protocol/deployments/%s byte for byte from its facts", (name) => {
    const text = readFileSync(repo(`protocol/deployments/${name}`), "utf8");
    const r = JSON.parse(text) as {
      chainId: number;
      address: Address;
      source: { commit: string };
      bytecode: { runtimeCodeHash: Hex };
      deployment: {
        method: "CREATE2" | "CREATE";
        deployer: Address | null;
        txHash: Hex;
        blockNumber: number;
        route?: "relayed";
        submitter?: Address;
        authorization?: { chainId: number; address: Address; nonce: number; authority: Address | null }[] | null;
      };
    };
    const runtimeCode = runtimeFor(r.chainId, r.address);
    expect(keccak256(runtimeCode)).toBe(r.bytecode.runtimeCodeHash);
    const d = r.deployment;
    const relayed =
      d.route === "relayed" && d.submitter !== undefined
        ? { submitter: d.submitter, authorization: d.authorization?.map((e) => ({ chainId: BigInt(e.chainId), address: e.address, nonce: BigInt(e.nonce), authority: e.authority })) ?? null }
        : undefined;
    const json = deploymentRecordJson(data, chain(r.chainId), {
      address: r.address,
      method: d.method,
      deployer: d.deployer,
      txHash: d.txHash,
      blockNumber: BigInt(d.blockNumber),
      runtimeCode,
      commit: r.source.commit,
      ...(relayed === undefined ? {} : { relayed }),
    });
    expect(json).toBe(text);
  });

  it("builds explorer links in the EIP-3091 layout", () => {
    expect(explorerLinks(chain(10143), "address", RELEASE.create2.address)).toEqual([
      { name: "MonadVision", href: `https://testnet.monadvision.com/address/${RELEASE.create2.address}` },
      { name: "Monadscan", href: `https://testnet.monadscan.com/address/${RELEASE.create2.address}` },
    ]);
  });
});
