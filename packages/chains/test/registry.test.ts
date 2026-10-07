// SPDX-License-Identifier: MIT
import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  arbitrumSepolia,
  arc,
  baseSepolia,
  CHAIN_DEFINITIONS,
  createRegistry,
  DEFAULT_RELAY_TIMING,
  defineLocalChain,
  DEPLOYMENT_RECORDS,
  mezoTestnet,
  monad,
  monadTestnet,
  RegistryError,
  registry,
  scopeToEdition,
  SNAPSHOT_GAS_LIMITS,
  SNAPSHOT_GAS_TABLE,
  MONAD_GAS_TABLE,
  EMULATED_GAS_LIMITS,
  RELEASE,
  GAS_MEASUREMENTS,
  toChecksumAddress,
  UnknownChainError,
  V1_CONFIG,
} from "../src/index.ts";
import type { ChainDefinition, Erc20Token, Token } from "../src/index.ts";

const erc20 = (chain: ChainDefinition, symbol: string): Erc20Token => {
  const token = chain.tokens.find((t): t is Erc20Token => t.kind === "erc20" && t.symbol === symbol);
  if (token === undefined) {
    throw new Error(`${symbol} not on ${chain.name}`);
  }
  return token;
};

/** The facts of PAYLINK-V2-SPEC §3.4, restated independently of src/ so a typo in either place fails. */
describe("spec §3.4 facts", () => {
  it("lists exactly the product's chains, in band-selector order", () => {
    expect(registry.chains.map((c) => [c.chainId, c.label, c.status, c.protocol])).toEqual([
      [10143, "MONAD", "enabled", "v2"],
      [143, "MONAD", "disabled", "v2"],
      [84532, "BASE", "enabled", "v2"],
      [421614, "ARB", "enabled", "v2"],
      [31611, "MEZO", "disabled", "v2"],
      [5042, "ARC", "enabled", "v1"],
    ]);
  });

  it("every v2 chain carries relay timing (A-04: minimum remaining validity at admission), v1 chains none", () => {
    expect(DEFAULT_RELAY_TIMING).toMatchObject({ minRemainingSeconds: 120, provisional: true });
    // 4 x the relayer's 30 s stuck-transaction replacement interval (PAYLINK-V2-SPEC §3.7), and at most half of the
    // recommended 600 s authorization window (invoice spec §8.3).
    expect(DEFAULT_RELAY_TIMING.minRemainingSeconds).toBe(4 * 30);
    expect(registry.chains.map((c) => [c.chainId, c.relay?.minRemainingSeconds ?? null])).toEqual([
      [10143, 120],
      [143, 120],
      [84532, 120],
      [421614, 120],
      [31611, 120],
      [5042, null],
    ]);
  });

  it("Monad testnet: AUSD default (6, 2612 + 3009), Circle USDC hidden (6, 3009, USDC/2), the impostor denied", () => {
    expect(monadTestnet.rpc.map((r) => [r.url, r.rateLimitRps])).toEqual([
      ["https://testnet-rpc.monad.xyz", 50],
      ["https://rpc-testnet.monadinfra.com", 20],
    ]);
    expect(monadTestnet.explorers.map((e) => e.url)).toEqual(["https://testnet.monadvision.com", "https://testnet.monadscan.com"]);
    const ausd = erc20(monadTestnet, "AUSD");
    expect([ausd.address, ausd.decimals, ausd.listing, ausd.capabilities]).toEqual([
      "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
      6,
      "default",
      { eip3009: true, eip2612: true, native: false },
    ]);
    const usdc = erc20(monadTestnet, "USDC");
    expect([usdc.address, usdc.decimals, usdc.listing, usdc.eip712Domain, usdc.capabilities.eip3009]).toEqual([
      "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      6,
      "hidden",
      { name: "USDC", version: "2" },
      true,
    ]);
    expect(monadTestnet.deniedTokens.map((d) => d.address)).toEqual(["0xf817257fed379853cDe0fa4F97AB987181B1E5Ea"]);
    expect(monadTestnet.gasModel).toEqual({ chargesGasLimit: true, txGasCap: 30_000_000n, reserveBalance: 10n ** 19n });
    expect(monadTestnet.rpcLimits.maxLogBlockRange).toBe(100);
    expect(monadTestnet.relay).toBe(DEFAULT_RELAY_TIMING);
    expect(monadTestnet.contracts.ausdFaucet?.address).toBe("0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C");
  });

  it("Monad mainnet is registry-only and disabled, with its unverified token facts flagged", () => {
    expect(monad.status).toBe("disabled");
    expect(monad.rpc).toEqual([]);
    expect(monad.tokens.map((t) => [t.symbol, t.address])).toEqual([
      ["AUSD", "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a"],
      ["USDC", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"],
    ]);
    for (const token of monad.tokens) {
      expect(token.pendingVerification).toContain("decimals");
      expect(token.capabilities).toEqual({ eip3009: false, eip2612: false, native: false });
    }
  });

  it("Base Sepolia: Circle USDC (6, 2612 + 3009)", () => {
    expect(baseSepolia.rpc.map((r) => r.url)).toEqual(["https://sepolia.base.org"]);
    const usdc = erc20(baseSepolia, "USDC");
    expect([usdc.address, usdc.decimals, usdc.capabilities]).toEqual([
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      6,
      { eip3009: true, eip2612: true, native: false },
    ]);
    expect(baseSepolia.gasModel.chargesGasLimit).toBe(false);
  });

  it("Arbitrum Sepolia: USDC (6), capabilities off until verified", () => {
    expect(arbitrumSepolia.rpc.map((r) => r.url)).toEqual(["https://sepolia-rollup.arbitrum.io/rpc"]);
    const usdc = erc20(arbitrumSepolia, "USDC");
    expect([usdc.address, usdc.decimals, usdc.capabilities]).toEqual([
      "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      6,
      { eip3009: false, eip2612: false, native: false },
    ]);
  });

  it("Mezo testnet: MUSD (18, 2612 only) and native BTC (18); disabled until the go/no-go", () => {
    expect(mezoTestnet.status).toBe("disabled");
    expect(mezoTestnet.rpc.map((r) => r.url)).toEqual(["https://rpc.test.mezo.org"]);
    const musd = erc20(mezoTestnet, "MUSD");
    expect([musd.address, musd.decimals, musd.capabilities]).toEqual([
      "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
      18,
      { eip3009: false, eip2612: true, native: false },
    ]);
    const btc = mezoTestnet.tokens.find((t) => t.kind === "native");
    expect([btc?.symbol, btc?.decimals, btc?.address]).toEqual(["BTC", 18, zeroAddress]);
    expect(mezoTestnet.contracts.btcErc20?.confidence).toBe("L");
  });

  it("Arc mainnet: v1 only, native USDC (18) and its 6-decimal ERC-20 view, facts from web/config.js", () => {
    expect(arc.protocol).toBe("v1");
    expect(arc.deployment).toBeNull();
    expect(arc.gas).toBeNull();
    expect(arc.v1).toEqual({
      address: V1_CONFIG.address,
      rpc: "https://rpc.mainnet.arc.io",
      explorer: V1_CONFIG.explorer,
      app: "https://nambininasafidison.github.io/paylink/web/",
      tag: "arc-microgrants-v1",
    });
    const native = arc.tokens.find((t) => t.kind === "native");
    expect(native?.decimals).toBe(18);
    const view = erc20(arc, "USDC");
    expect([view.address, view.decimals, view.eip712Domain, view.capabilities.eip3009]).toEqual([
      "0x3600000000000000000000000000000000000000",
      6,
      { name: "USDC", version: "2" },
      true,
    ]);
  });

  it("Monad uses the bounds of its own gas schedule; the other v2 chains the snapshot (all provisional)", () => {
    for (const chain of registry.chains.filter((c) => c.protocol === "v2")) {
      const expected = chain.key === "monad" || chain.key === "monad-testnet" ? MONAD_GAS_TABLE : SNAPSHOT_GAS_TABLE;
      expect(chain.gas).toBe(expected);
      expect(chain.gas?.provisional).toBe(true);
    }
    expect(MONAD_GAS_TABLE).toMatchObject({ source: "emulated", limits: EMULATED_GAS_LIMITS.monad });
    expect(MONAD_GAS_TABLE.evidence).toContain("MonadTen");
    expect(SNAPSHOT_GAS_TABLE).toMatchObject({ source: "snapshot", limits: SNAPSHOT_GAS_LIMITS });
  });

  it("every v2 chain is covered by exactly one measured anvil profile", () => {
    const profiles = Object.values(GAS_MEASUREMENTS);
    for (const chain of registry.chains.filter((c) => c.protocol === "v2")) {
      expect(profiles.filter((p) => (p.appliesTo as readonly number[]).includes(chain.chainId)), chain.name).toHaveLength(1);
    }
    expect(GAS_MEASUREMENTS.monad.network).toBe("monad");
    expect(GAS_MEASUREMENTS.base.network).toBe("base");
    expect(GAS_MEASUREMENTS.london.hardfork).toBe("London");
  });

  it("has a deployment exactly where protocol/deployments records one", () => {
    // Data-driven, so recording a real deployment (tools/verify-deployment, Deploy.s.sol record()) and regenerating
    // keeps this suite green; test/generated.test.ts checks that the records were regenerated.
    for (const chain of registry.chains) {
      const record = DEPLOYMENT_RECORDS[chain.chainId];
      if (record === undefined) {
        expect(chain.deployment).toBeNull();
        expect(registry.v2Target(chain.chainId)).toBeUndefined();
      } else {
        expect(chain.deployment).toMatchObject({ address: record.address, txHash: record.txHash, initCodeHash: RELEASE.initCodeHash });
      }
    }
  });
});

describe("lookups", () => {
  it("finds chains and throws UnknownChainError for unknown ones", () => {
    expect(registry.get(84532)).toBe(baseSepolia);
    expect(registry.get(1)).toBeUndefined();
    expect(registry.getOrThrow(10143)).toBe(monadTestnet);
    expect(() => registry.getOrThrow(1)).toThrow(UnknownChainError);
    try {
      registry.getOrThrow(31337);
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownChainError);
      expect((error as UnknownChainError).chainId).toBe(31337);
      expect((error as UnknownChainError).name).toBe("UnknownChainError");
    }
  });

  it("finds tokens case-insensitively and never returns a denied address", () => {
    const ausd = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
    expect(registry.findToken(10143, ausd.toLowerCase())?.symbol).toBe("AUSD");
    expect(registry.findToken(10143, ausd.toUpperCase().replace("0X", "0x"))?.symbol).toBe("AUSD");
    expect(registry.findToken(84532, ausd)).toBeUndefined();
    expect(registry.findToken(1, ausd)).toBeUndefined();
    const impostor = "0xf817257fed379853cde0fa4f97ab987181b1e5ea";
    expect(registry.findToken(10143, impostor)).toBeUndefined();
    expect(registry.findDenied(10143, impostor)?.reason).toMatch(/never use/);
    expect(registry.findDenied(84532, impostor)).toBeUndefined();
    expect(registry.findDenied(1, impostor)).toBeUndefined();
  });

  it("scopes chains to an edition", () => {
    expect(registry.forEdition("monad").map((c) => c.chainId)).toEqual([10143]);
    expect(registry.forEdition("monad", { includeDisabled: true }).map((c) => c.chainId)).toEqual([10143, 143]);
    expect(registry.forEdition("base").map((c) => c.chainId)).toEqual([84532, 421614]);
    expect(registry.forEdition("mezo").map((c) => c.chainId)).toEqual([]);
    expect(registry.forEdition("all").map((c) => c.chainId)).toEqual([10143, 84532, 421614]);
    expect(registry.forEdition("all", { includeDisabled: true }).map((c) => c.chainId)).toEqual([10143, 143, 84532, 421614, 31611]);
    const base = scopeToEdition(registry, "base");
    expect(base.get(10143)).toBeUndefined();
    expect(base.get(84532)).toBe(baseSepolia);
    expect(scopeToEdition(registry, "mezo", { includeDisabled: true }).chains.map((c) => c.chainId)).toEqual([31611]);
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.chains)).toBe(true);
    expect(Object.isFrozen(monadTestnet.tokens[0])).toBe(true);
    const [first] = monadTestnet.tokens;
    expect(() => {
      (monadTestnet.tokens as Token[]).push(...(first === undefined ? [] : [first]));
    }).toThrow(TypeError);
  });

  it("normalises addresses to EIP-55", () => {
    expect(toChecksumAddress("0xa9012a055bd4e0edff8ce09f960291c09d5322dc")).toBe("0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC");
    expect(toChecksumAddress("0x1234")).toBeUndefined();
  });
});

describe("createRegistry validation", () => {
  const token: Erc20Token = {
    kind: "erc20",
    symbol: "MOCK",
    name: "Mock 3009",
    address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    decimals: 6,
    capabilities: { eip3009: true, eip2612: true, native: false },
    eip712Domain: { name: "Mock", version: "1" },
    listing: "default",
    confidence: "C",
    pendingVerification: [],
  };
  const deployment = {
    address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    status: "active",
    release: "2.0.0",
    method: "CREATE",
    deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    txHash: `0x${"11".repeat(32)}`,
    blockNumber: 1n,
    initCodeHash: `0x${"22".repeat(32)}`,
    maskedRuntimeHash: `0x${"33".repeat(32)}`,
    runtimeCodeHash: `0x${"44".repeat(32)}`,
  } as const;
  const base = defineLocalChain({ chainId: 31337, rpcUrl: "http://127.0.0.1:8545", tokens: [token], deployment });

  /** Expects `createRegistry` to refuse the chain with an issue matching `pattern`. */
  const refuses = (chain: unknown, pattern: RegExp): void => {
    let caught: unknown;
    try {
      createRegistry([chain as ChainDefinition]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    const issues = (caught as RegistryError).issues;
    expect(issues.some((issue) => pattern.test(issue)), issues.join("\n")).toBe(true);
    expect((caught as RegistryError).message).toContain("invalid chain registry");
  };

  it("accepts a local chain and resolves its v2 target", () => {
    const local = createRegistry([base]);
    expect(local.v2Target(31337)).toEqual({ chain: base, deployment });
    expect(local.findToken(31337, token.address)).toBe(token);
    expect(local.forEdition("all")).toEqual([base]);
  });

  it("accepts every shipped chain", () => {
    expect(() => createRegistry(CHAIN_DEFINITIONS)).not.toThrow();
  });

  it.each([
    [{ chainId: 0 }, /chainId must be an integer/],
    [{ chainId: 2 ** 53 }, /chainId must be an integer/],
    [{ caip2: "eip155:1" }, /caip2 must be eip155:31337/],
    [{ testnet: false }, /local chain has key "local" and is a testnet/],
    [{ editions: ["paypal"] }, /unknown edition paypal/],
    [{ rpc: [{ url: "not a url", confidence: "C" }] }, /is not a URL/],
    [{ rpc: [{ url: "http://rpc.example.org", confidence: "C" }] }, /must use https/],
    [{ rpc: [{ url: "https://user:pw@rpc.example.org", confidence: "C" }] }, /credentials, a query or a fragment/],
    [{ rpc: [{ url: "https://rpc.example.org/?key=1", confidence: "C" }] }, /credentials, a query or a fragment/],
    [{ rpc: [] }, /needs at least one RPC endpoint/],
    [{ explorers: [{ name: "x", url: "https://scan.example.org/", confidence: "C" }] }, /bare origin/],
    [{ tokens: [{ ...token, address: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" }] }, /not EIP-55 checksummed/],
    [{ tokens: [{ ...token, address: "0x1234" }] }, /is not an address/],
    [{ tokens: [{ ...token, decimals: 37 }] }, /decimals must be an integer/],
    [{ tokens: [{ ...token, decimals: 1.5 }] }, /decimals must be an integer/],
    [{ tokens: [{ ...token, symbol: " " }] }, /symbol and name are required/],
    [{ tokens: [{ ...token, address: zeroAddress }] }, /ERC-20 token has a non-zero address/],
    [{ tokens: [{ ...token, capabilities: { eip3009: false, eip2612: false, native: true } }] }, /ERC-20 token has a non-zero address/],
    [{ tokens: [{ ...token, kind: "native" }] }, /native token has the zero address/],
    [{ tokens: [{ ...token, kind: "native", address: zeroAddress, capabilities: { eip3009: true, eip2612: false, native: true } }] }, /native token/],
    [{ tokens: [{ ...token, kind: "native", address: zeroAddress, capabilities: { eip3009: false, eip2612: true, native: true } }] }, /native token/],
    [{ tokens: [{ ...token, kind: "native", address: zeroAddress, capabilities: { eip3009: false, eip2612: false, native: false } }] }, /native token/],
    [{ tokens: [{ ...token, address: deployment.address }] }, /cannot be the PayLinkV2 deployment/],
    [{ tokens: [token, token] }, /listed twice/],
    [{ tokens: [token, { ...token, address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }] }, /at most one default token/],
    [{ tokens: [{ ...token, pendingVerification: ["decimals"] }] }, /cannot carry unverified facts \(decimals\)/],
    [{ deniedTokens: [{ address: token.address, reason: "x", confidence: "C" }] }, /on the chain's deny list/],
    [{ deniedTokens: [{ address: "0xf817257fed379853cde0fa4f97ab987181b1e5ea", reason: "x", confidence: "C" }] }, /denied.*not EIP-55/],
    [{ contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11", confidence: "L" } } }, /contracts.multicall3.*not EIP-55/],
    [{ gas: null }, /v2 chain needs a gas table/],
    [{ gas: { source: "snapshot", provisional: true, limits: { ...SNAPSHOT_GAS_LIMITS, pay: { floor: 0n, ceiling: 1n } } } }, /gas bounds of pay/],
    [{ gas: { source: "snapshot", provisional: true, limits: { ...SNAPSHOT_GAS_LIMITS, cancel: { floor: 10n, ceiling: 9n } } } }, /gas bounds of cancel/],
    [{ relay: null }, /v2 chain needs relay timing/],
    [{ relay: { ...DEFAULT_RELAY_TIMING, minRemainingSeconds: 0 } }, /relay.minRemainingSeconds must be an integer in \[1, 300\]/],
    [{ relay: { ...DEFAULT_RELAY_TIMING, minRemainingSeconds: 301 } }, /relay.minRemainingSeconds must be an integer/],
    [{ relay: { ...DEFAULT_RELAY_TIMING, minRemainingSeconds: 60.5 } }, /relay.minRemainingSeconds must be an integer/],
    [{ v1: arc.v1 }, /v2 chain carries no v1 info/],
    [{ deployment: { ...deployment, address: "0x5fbdb2315678afecb367f032d93f642f64180aa3" } }, /deployment.*not EIP-55/],
    [{ deployment: { ...deployment, address: zeroAddress }, tokens: [] }, /deployment address cannot be zero/],
    [{ protocol: "v1", deployment: null, gas: null, relay: null, editions: [], v1: null }, /v1 chain needs its v1 info/],
    [{ protocol: "v1", deployment: null, relay: null, editions: [], v1: arc.v1 }, /v1 chain has no v2 gas table/],
    [{ protocol: "v1", deployment: null, gas: null, editions: [], v1: arc.v1 }, /v1 chain has no v2 gas table, relay timing/],
    [{ protocol: "v1", deployment: null, gas: null, relay: null, editions: [], v1: { ...arc.v1, address: "0x5fbdb2315678afecb367f032d93f642f64180aa3" } }, /v1.address.*not EIP-55/],
  ])("refuses %o", (patch, pattern) => {
    refuses({ ...base, ...patch }, pattern);
  });

  it("accepts a v1 chain with a deployed v1 contract", () => {
    if (arc.v1 === null) {
      throw new Error("Arc carries v1 info");
    }
    const v1 = { ...arc, v1: { ...arc.v1, address: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const } };
    expect(createRegistry([v1]).get(5042)?.v1?.address).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
  });

  it("refuses non-local chains with an http RPC even on localhost", () => {
    refuses({ ...baseSepolia, rpc: [{ url: "http://127.0.0.1:8545", confidence: "C" }] }, /must use https/);
  });

  it("refuses duplicate chain IDs and duplicate keys, but allows several local chains", () => {
    expect(() => createRegistry([baseSepolia, baseSepolia])).toThrow(/defined twice/);
    expect(() => createRegistry([baseSepolia, { ...arbitrumSepolia, key: "base-sepolia" }])).toThrow(/key base-sepolia is used twice/);
    const other = defineLocalChain({ chainId: 10143, rpcUrl: "http://localhost:8546", tokens: [], deployment: null, name: "anvil as Monad" });
    expect(createRegistry([base, other]).chains).toHaveLength(2);
    expect(other.name).toBe("anvil as Monad");
  });
});
