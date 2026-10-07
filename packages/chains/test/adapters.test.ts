// SPDX-License-Identifier: MIT
import { createPublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  arc,
  baseSepolia,
  DEFAULT_RELAY_TIMING,
  defineLocalChain,
  explorerAddressUrl,
  explorerBlockUrl,
  explorerTxUrl,
  monad,
  monadTestnet,
  rpcTransport,
  SNAPSHOT_GAS_TABLE,
  toViemChain,
} from "../src/index.ts";

describe("explorer links (EIP-3091 layout)", () => {
  const scan = baseSepolia.explorers[0];
  if (scan === undefined) {
    throw new Error("Base Sepolia has an explorer");
  }

  it("builds tx, address and block links", () => {
    expect(explorerTxUrl(scan, `0x${"ab".repeat(32)}`)).toBe(`https://sepolia.basescan.org/tx/0x${"ab".repeat(32)}`);
    expect(explorerAddressUrl(scan, "0x036CbD53842c5426634e7929541eC2318f3dCF7e")).toBe(
      "https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    );
    expect(explorerBlockUrl(scan, 123n)).toBe("https://sepolia.basescan.org/block/123");
  });
});

describe("toViemChain", () => {
  it("maps id, name, currency, every RPC in order, the first explorer and Multicall3", () => {
    const chain = toViemChain(monadTestnet);
    expect(chain.id).toBe(10143);
    expect(chain.name).toBe("Monad testnet");
    expect(chain.nativeCurrency).toEqual({ name: "Monad", symbol: "MON", decimals: 18 });
    expect(chain.rpcUrls.default.http).toEqual(["https://testnet-rpc.monad.xyz", "https://rpc-testnet.monadinfra.com"]);
    expect(chain.blockExplorers?.default).toEqual({ name: "MonadVision", url: "https://testnet.monadvision.com" });
    expect(chain.contracts?.multicall3?.address).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
    expect(chain.testnet).toBe(true);
  });

  it("omits explorers and Multicall3 when the registry has none", () => {
    const chain = toViemChain(arc);
    expect(chain.blockExplorers).toBeUndefined();
    expect(chain.contracts).toBeUndefined();
    expect(chain.testnet).toBe(false);
  });

  it("refuses a chain without RPC endpoints", () => {
    expect(() => toViemChain(monad)).toThrow(/no RPC endpoint/);
  });
});

describe("rpcTransport", () => {
  /** The URLs of a fallback transport, in order. */
  const urlsOf = (transport: ReturnType<typeof rpcTransport>): string[] => {
    const { value } = transport({ chain: toViemChain(monadTestnet) });
    return (value?.transports ?? []).map((t) => t.value?.url ?? "");
  };

  it("falls back across the registry RPCs in order", () => {
    expect(urlsOf(rpcTransport(monadTestnet))).toEqual(["https://testnet-rpc.monad.xyz", "https://rpc-testnet.monadinfra.com"]);
  });

  it("tries preferred same-origin-config URLs first, without duplicates", () => {
    const transport = rpcTransport(monadTestnet, {
      preferredUrls: ["https://rpc-testnet.monadinfra.com", "https://rpc.example.org"],
      timeoutMs: 5000,
      retryCount: 1,
    });
    expect(urlsOf(transport)).toEqual(["https://rpc-testnet.monadinfra.com", "https://rpc.example.org", "https://testnet-rpc.monad.xyz"]);
  });

  it("builds a working viem client", () => {
    const client = createPublicClient({ chain: toViemChain(baseSepolia), transport: rpcTransport(baseSepolia) });
    expect(client.chain.id).toBe(84532);
  });

  it("refuses non-https preferred URLs and chains without RPCs", () => {
    expect(() => rpcTransport(monadTestnet, { preferredUrls: ["http://rpc.example.org"] })).toThrow(/must use https/);
    expect(() => rpcTransport(monad)).toThrow(/no RPC endpoint/);
  });
});

describe("defineLocalChain", () => {
  it("defaults to the snapshot gas table, the all edition and no gas-limit charging", () => {
    const local = defineLocalChain({ chainId: 31337, rpcUrl: "http://127.0.0.1:8545", tokens: [], deployment: null });
    expect(local).toMatchObject({
      key: "local",
      local: true,
      testnet: true,
      protocol: "v2",
      editions: ["all"],
      gas: SNAPSHOT_GAS_TABLE,
      relay: DEFAULT_RELAY_TIMING,
      gasModel: { chargesGasLimit: false },
      name: "Local (anvil 31337)",
      caip2: "eip155:31337",
    });
  });

  it("can mimic Monad's gas-limit charging and a custom gas table and editions", () => {
    const gas = { ...SNAPSHOT_GAS_TABLE, source: "testnet" as const, provisional: false };
    const local = defineLocalChain({
      chainId: 10143,
      rpcUrl: "http://localhost:8545",
      tokens: [],
      deployment: null,
      editions: ["monad"],
      gas,
      chargesGasLimit: true,
      relay: { minRemainingSeconds: 30, provisional: false, basis: "measured" },
    });
    expect(local.relay?.minRemainingSeconds).toBe(30);
    expect(local.gasModel.chargesGasLimit).toBe(true);
    expect(local.gas).toBe(gas);
    expect(local.editions).toEqual(["monad"]);
  });
});
