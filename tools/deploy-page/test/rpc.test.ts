// SPDX-License-Identifier: MIT
/** web/v2/deploy/lib/rpc.js, format.js and the pure parts of wallet.js. */
import { describe, expect, it } from "vitest";
import * as fmt from "../../../web/v2/deploy/lib/format.js";
import { httpRpc, providerRpc, reader, RpcError, TransportError } from "../../../web/v2/deploy/lib/rpc.js";
import { relayEvidence } from "../../../web/v2/deploy/lib/verify.js";
import { isUnknownChainError, walletMessage } from "../../../web/v2/deploy/lib/wallet.js";

type Handler = (url: string, body: { method: string; params: unknown[] }) => Response | Promise<Response>;
const fakeFetch =
  (handler: Handler): typeof fetch =>
  (input, init) =>
    Promise.resolve(handler(input as string, JSON.parse(init?.body as string) as { method: string; params: unknown[] }));
const ok = (result: unknown): Response => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));

describe("httpRpc", () => {
  it("falls back across endpoints that fail at the transport level", async () => {
    const seen: string[] = [];
    const rpc = httpRpc(["https://a.example", "https://b.example", "https://c.example"], {
      fetch: fakeFetch((url) => {
        seen.push(url);
        if (url.includes("a.")) {
          return new Response("bad gateway", { status: 502 });
        }
        if (url.includes("b.")) {
          return new Response("<html>not json-rpc</html>");
        }
        return ok("0x279f");
      }),
    });
    expect(await rpc.request("eth_chainId")).toBe("0x279f");
    expect(seen).toEqual(["https://a.example", "https://b.example", "https://c.example"]);
    expect(rpc.lastUrl()).toBe("https://c.example");
  });

  it("throws a JSON-RPC error as the answer, without asking the next endpoint", async () => {
    const seen: string[] = [];
    const rpc = httpRpc(["https://a.example", "https://b.example"], {
      fetch: fakeFetch((url) => {
        seen.push(url);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }));
      }),
    });
    await expect(rpc.request("eth_call", [])).rejects.toMatchObject({ name: "RpcError", code: -32000 });
    expect(seen).toEqual(["https://a.example"]);
  });

  it("reports every endpoint when none answers", async () => {
    const rpc = httpRpc(["https://a.example"], {
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await expect(rpc.request("eth_chainId")).rejects.toBeInstanceOf(TransportError);
    await expect(rpc.request("eth_chainId")).rejects.toThrow(/a\.example: Failed to fetch/);
  });

  it("times out a hanging endpoint", async () => {
    const rpc = httpRpc(["https://slow.example"], {
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });
    await expect(rpc.request("eth_chainId")).rejects.toThrow(/slow\.example: aborted/);
  });
});

describe("reader", () => {
  const read = reader(
    providerRpc({
      request: ({ method }) => {
        const answers: Record<string, unknown> = {
          eth_chainId: "0x279f",
          eth_getCode: "0x6080ABCD",
          eth_getBalance: "0x4563918244f40000",
          eth_getTransactionCount: "0x7",
          eth_getBlockByNumber: { number: "0x10", baseFeePerGas: "0x174876e800" },
          eth_maxPriorityFeePerGas: "0x77359400",
          eth_getTransactionByHash: { hash: "0xAB", from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", to: null, input: "0x60", nonce: "0x0", gas: "0x2dc6c0" },
          eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x10", contractAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3", gasUsed: "0x5208" },
        };
        if (method === "eth_call") {
          return Promise.reject(Object.assign(new Error("execution reverted"), { code: 3 }));
        }
        return Promise.resolve(answers[method]);
      },
    }),
  );

  it("decodes quantities, lowercases code and checksums addresses", async () => {
    expect(await read.chainId()).toBe(10143);
    expect(await read.code("0x5FbDB2315678afecb367f032d93F642f64180aa3")).toBe("0x6080abcd");
    expect(await read.balance("0x5FbDB2315678afecb367f032d93F642f64180aa3")).toBe(5_000_000_000_000_000_000n);
    expect(await read.pendingNonce("0x5FbDB2315678afecb367f032d93F642f64180aa3")).toBe(7);
    expect(await read.fees()).toEqual({ baseFee: 100_000_000_000n, priorityFee: 2_000_000_000n, block: 16n });
    expect(await read.transaction("0xab", 10143)).toEqual({
      hash: "0xab",
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      to: null,
      input: "0x60",
      nonce: 0,
      gas: 3_000_000n,
      chainId: 10143,
      type: 0,
      authorizationList: null,
    });
    expect(await read.receipt("0xab")).toEqual({ success: true, blockNumber: 16n, contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3", gasUsed: 21_000n });
  });

  it("reports a reverting eip712Domain() as null, not as an error", async () => {
    expect(await read.eip712Domain("0x5FbDB2315678afecb367f032d93F642f64180aa3")).toBeNull();
  });
});

describe("reader, relayed deployments", () => {
  const BLOCK = 47_859_253n;
  const ADDRESS = "0x448eCce9711860502806A3d5B021a4f9Ba715082";
  const USER = "0x0c397c6c8F94EAA6662eE548fA140e6DfEd4aea6";
  const relayedTx = {
    type: "0x4",
    chainId: "0x14a34",
    hash: "0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed",
    from: "0xc066ac5d385419b1a8c43a0e146fa439837a8b8c",
    to: "0xdb9b1e94b5b69df7e401ddbede43491141047db3",
    input: `0xcef6d209${USER.slice(2).toLowerCase().padStart(64, "0")}`,
    nonce: "0x1e125",
    gas: "0x374ae0",
    // As sepolia.base.org returns it: r and s are quantities, so r lost its leading zero.
    authorizationList: [
      {
        chainId: "0x14a34",
        address: "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b",
        nonce: "0x0",
        yParity: "0x0",
        r: "0x3fca8aff26ea0f1251afc940e234c777342b93fcfb4a5d51c728bfea7715b09",
        s: "0x228ddefc70eddfdf68e5d2b444012c605ee2c52ed14e0ea712f0659c9a4fbbc7",
      },
    ],
  };
  /** A non-archive endpoint: no state before `oldest`, no tracer (the answers of sepolia.base.org's filter). */
  const endpoint = (oldest: bigint) =>
    reader(
      providerRpc({
        request: ({ method, params = [] }) => {
          if (method === "eth_getTransactionByHash") {
            return Promise.resolve(relayedTx);
          }
          if (method === "eth_getCode") {
            const [address, block] = params as [string, string];
            if (block !== "latest" && BigInt(block) < oldest) {
              return Promise.reject(Object.assign(new Error("missing trie node"), { code: -32000 }));
            }
            if (address === USER) {
              return Promise.resolve("0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b");
            }
            return Promise.resolve(block === "latest" || BigInt(block) >= BLOCK ? "0x6080" : "0x");
          }
          return Promise.reject(Object.assign(new Error("rejected due to request filter settings"), { code: -32611 }));
        },
      }),
    );

  it("decodes a type-4 transaction and its authorization list", async () => {
    const tx = await endpoint(0n).transaction(relayedTx.hash as `0x${string}`, 84532);
    expect(tx).toMatchObject({ type: 4, chainId: 84532, to: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" });
    expect(tx?.authorizationList).toEqual([
      {
        chainId: 84532n,
        address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
        nonce: 0n,
        yParity: 0,
        r: 0x03fca8aff26ea0f1251afc940e234c777342b93fcfb4a5d51c728bfea7715b09n,
        s: 0x228ddefc70eddfdf68e5d2b444012c605ee2c52ed14e0ea712f0659c9a4fbbc7n,
      },
    ]);
  });

  it("reads code at past blocks and reports refused traces without throwing", async () => {
    const read = endpoint(0n);
    expect(await read.codeAt(ADDRESS, BLOCK - 1n)).toBe("0x");
    expect(await read.codeAt(ADDRESS, BLOCK)).toBe("0x6080");
    expect(await read.trace(relayedTx.hash as `0x${string}`)).toEqual({
      source: null,
      result: null,
      errors: ["debug_traceTransaction: rejected due to request filter settings", "trace_transaction: rejected due to request filter settings"],
    });
  });

  it("gathers the relayed evidence, falling back to the latest block where the endpoint keeps no state", async () => {
    const receipt = { success: true, blockNumber: BLOCK, contractAddress: null, gasUsed: 3_260_830n };
    const archive = endpoint(0n);
    const tx = await archive.transaction(relayedTx.hash as `0x${string}`, 84532);
    if (tx === null) {
      throw new Error("no tx");
    }
    expect(await relayEvidence({ read: archive, chainId: 84532, address: ADDRESS, tx, receipt })).toEqual({
      before: { block: BLOCK - 1n, code: "0x", error: null },
      after: { block: BLOCK, code: "0x6080", error: null },
      trace: { source: null, result: null, errors: expect.any(Array) as unknown },
      authorities: { [USER]: { block: BLOCK, code: "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b", error: null } },
    });
    const pruned = await relayEvidence({ read: endpoint(BLOCK + 100n), chainId: 84532, address: ADDRESS, tx, receipt });
    expect(pruned.before).toEqual({ block: BLOCK - 1n, code: null, error: "missing trie node" });
    expect(pruned.after).toEqual({ block: "latest", code: "0x6080", error: "missing trie node" });
    expect(pruned.authorities[USER]).toEqual({ block: "latest", code: "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b", error: "missing trie node" });
  });
});

describe("wallet errors", () => {
  it("recognises 'unknown chain' answers, including MetaMask mobile's wrapped form", () => {
    expect(isUnknownChainError(new RpcError(4902, "Unrecognized chain ID"))).toBe(true);
    expect(isUnknownChainError(new RpcError(-32603, "Unrecognized chain ID \"0x14a34\". Try adding the chain using wallet_addEthereumChain first."))).toBe(true);
    expect(isUnknownChainError(new RpcError(-32603, "internal", { originalError: { code: 4902 } }))).toBe(true);
    expect(isUnknownChainError(new RpcError(4001, "User rejected"))).toBe(false);
    expect(isUnknownChainError(new Error("x"))).toBe(false);
  });

  it("explains rejections in plain words", () => {
    expect(walletMessage(new RpcError(4001, "User rejected the request."))).toMatch(/declined/);
    expect(walletMessage(new RpcError(-32002, "pending"))).toMatch(/already has a request/);
    expect(walletMessage(new RpcError(-32000, "insufficient funds"))).toBe("Wallet or RPC error -32000: insufficient funds");
  });
});

describe("format", () => {
  it("rounds costs up and balances down", () => {
    expect(fmt.native(305_970_000_000_000_001n, 18, "up")).toBe("0.3060");
    expect(fmt.native(305_979_999_999_999_999n, 18, "down")).toBe("0.3059");
    expect(fmt.native(5n * 10n ** 18n, 18, "down")).toBe("5.0000");
    expect(fmt.native(16_342_248_000_000n, 18, "up")).toBe("0.000017");
    expect(fmt.native(123n, 18, "up")).toBe("0.000000000000000123");
    expect(fmt.native(0n, 18, "up")).toBe("0");
    expect(fmt.native(1_234_567n * 10n ** 18n, 18, "down")).toBe("1,234,567.0000");
  });

  it("prints gas and gwei", () => {
    expect(fmt.gas(2_999_705n)).toBe("2,999,705");
    expect(fmt.gwei(102_000_000_000n)).toBe("102");
    expect(fmt.gwei(6_000_000n)).toBe("0.006");
    expect(fmt.gwei(90_768_000n)).toBe("0.091");
  });
});
