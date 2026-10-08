// SPDX-License-Identifier: MIT
// @ts-check
/**
 * Minimal JSON-RPC for the deploy page and the CLI: an EIP-1193 provider (the wallet) or the registry's HTTPS
 * endpoints with fallback, plus the reads a deployment needs. No endpoint ever comes from a URL or user input on the
 * page: HTTP endpoints are the registry's (data/chains.json), and the CLI accepts a loopback override for tests only.
 *
 * @module
 */
import { getAddress, hexToBigInt, numberToHex } from "../vendor/viem.js";
import { EIP712_DOMAIN_CALLDATA } from "./core.js";

/** @typedef {import("./core.js").Hex} Hex */
/** @typedef {import("./core.js").Address} Address */
/** @typedef {import("./core.js").TxFacts} TxFacts */
/** @typedef {import("./core.js").ReceiptFacts} ReceiptFacts */
/** @typedef {import("./eip7702.js").Authorization} Authorization */

/** @typedef {{ request: (method: string, params?: readonly unknown[]) => Promise<unknown> }} Rpc */
/** @typedef {{ request: (args: { method: string; params?: readonly unknown[] }) => Promise<unknown> }} Eip1193Provider */

/** A JSON-RPC or EIP-1193 error answer (code and message as the endpoint gave them). */
export class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   * @param {unknown} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** The endpoint could not be reached or answered something that is not JSON-RPC. */
export class TransportError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * Wraps an EIP-1193 provider. Provider errors keep their numeric `code` (4001 user rejected, 4902 unknown chain, ...).
 *
 * @param {Eip1193Provider} provider
 * @returns {Rpc}
 */
export function providerRpc(provider) {
  return {
    async request(method, params = []) {
      try {
        return await provider.request({ method, params });
      } catch (error) {
        const e = /** @type {{ code?: unknown; message?: unknown; data?: unknown }} */ (error);
        if (typeof e === "object" && e !== null && typeof e.code === "number") {
          throw new RpcError(e.code, typeof e.message === "string" ? e.message : "wallet error", e.data);
        }
        throw error;
      }
    },
  };
}

/**
 * JSON-RPC over HTTPS with fallback, in the registry's order. An endpoint that cannot be reached, times out or answers
 * garbage is skipped; a JSON-RPC error is an answer and is thrown as is (the next endpoint would say the same).
 *
 * @param {readonly string[]} urls
 * @param {{ timeoutMs?: number; fetch?: typeof fetch }} [options]
 * @returns {Rpc & { lastUrl: () => string | null }}
 */
export function httpRpc(urls, { timeoutMs = 15_000, fetch: fetchImpl = globalThis.fetch } = {}) {
  let id = 0;
  /** @type {string | null} */
  let last = null;
  return {
    lastUrl: () => last,
    async request(method, params = []) {
      /** @type {string[]} */
      const failures = [];
      for (const url of urls) {
        id += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, timeoutMs);
        /** @type {unknown} */
        let body;
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            signal: controller.signal,
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
          if (!response.ok) {
            throw new TransportError(`HTTP ${String(response.status)}`);
          }
          body = await response.json();
        } catch (error) {
          failures.push(`${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        } finally {
          clearTimeout(timer);
        }
        const answer = /** @type {{ result?: unknown; error?: { code: number; message: string; data?: unknown } }} */ (body);
        if (typeof answer !== "object" || answer === null || (!("result" in answer) && !("error" in answer))) {
          failures.push(`${new URL(url).host}: not a JSON-RPC answer`);
          continue;
        }
        last = url;
        if (answer.error !== undefined) {
          throw new RpcError(answer.error.code, answer.error.message, answer.error.data);
        }
        return answer.result;
      }
      throw new TransportError(`no RPC endpoint answered ${method} (${failures.join("; ")})`);
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {Hex}
 */
function hex(value, what) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new TransportError(`${what}: not hex (${JSON.stringify(value)})`);
  }
  return /** @type {Hex} */ (value.toLowerCase());
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {bigint}
 */
const quantity = (value, what) => hexToBigInt(hex(value, what));

/**
 * A type-4 transaction's `authorizationList` entries (quantities as the RPC gives them, `r` and `s` possibly unpadded).
 * @param {unknown} list
 * @returns {Authorization[] | null}
 */
function authorizations(list) {
  if (!Array.isArray(list)) {
    return null;
  }
  return list.map((raw, i) => {
    const a = /** @type {Record<string, unknown>} */ (raw);
    const what = `authorizationList[${String(i)}]`;
    const yParity = a["yParity"] ?? a["v"];
    return {
      chainId: quantity(a["chainId"], `${what}.chainId`),
      address: getAddress(hex(a["address"], `${what}.address`)),
      nonce: quantity(a["nonce"], `${what}.nonce`),
      yParity: Number(quantity(yParity, `${what}.yParity`)),
      r: quantity(a["r"], `${what}.r`),
      s: quantity(a["s"], `${what}.s`),
    };
  });
}

/** The traces a relayed deployment may be confirmed with, most common first. */
const TRACERS = /** @type {const} */ ([
  ["debug_traceTransaction (callTracer)", "debug_traceTransaction", (/** @type {Hex} */ hash) => [hash, { tracer: "callTracer" }]],
  ["trace_transaction", "trace_transaction", (/** @type {Hex} */ hash) => [hash]],
]);

/**
 * Typed reads over any `Rpc`.
 * @param {Rpc} rpc
 */
export function reader(rpc) {
  return {
    rpc,
    chainId: async () => Number(quantity(await rpc.request("eth_chainId"), "eth_chainId")),
    /** @param {Address} address */
    code: async (address) => hex(await rpc.request("eth_getCode", [address, "latest"]), "eth_getCode"),
    /** Code at a past block: a JSON-RPC error (RpcError) when the endpoint keeps no state there. @param {Address} address @param {bigint} block */
    codeAt: async (address, block) => hex(await rpc.request("eth_getCode", [address, numberToHex(block)]), "eth_getCode"),
    /**
     * The transaction's trace from the first tracer the endpoint serves, or the refusals (public endpoints usually
     * refuse both). Never throws: a trace only adds evidence.
     * @param {Hex} hash
     * @returns {Promise<{ source: string | null; result: unknown; errors: string[] }>}
     */
    async trace(hash) {
      /** @type {string[]} */
      const errors = [];
      for (const [source, method, params] of TRACERS) {
        try {
          const result = /** @type {unknown} */ (await rpc.request(method, params(hash)));
          if (result !== null && result !== undefined) {
            return { source, result, errors };
          }
          errors.push(`${method}: empty answer`);
        } catch (error) {
          errors.push(`${method}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { source: null, result: null, errors };
    },
    /** @param {Address} address */
    balance: async (address) => quantity(await rpc.request("eth_getBalance", [address, "latest"]), "eth_getBalance"),
    /** @param {Address} address */
    pendingNonce: async (address) => Number(quantity(await rpc.request("eth_getTransactionCount", [address, "pending"]), "eth_getTransactionCount")),
    /** @param {{ from: Address; to: Address | null; data: Hex }} tx */
    estimateGas: async (tx) =>
      quantity(await rpc.request("eth_estimateGas", [{ from: tx.from, ...(tx.to === null ? {} : { to: tx.to }), data: tx.data, value: "0x0" }]), "eth_estimateGas"),
    async fees() {
      const block = /** @type {{ baseFeePerGas?: string; number: string } | null} */ (await rpc.request("eth_getBlockByNumber", ["latest", false]));
      if (block === null) {
        throw new TransportError("latest block not found");
      }
      const baseFee = block.baseFeePerGas === undefined ? null : quantity(block.baseFeePerGas, "baseFeePerGas");
      /** @type {bigint} */
      let priorityFee;
      try {
        priorityFee = quantity(await rpc.request("eth_maxPriorityFeePerGas"), "eth_maxPriorityFeePerGas");
      } catch {
        const gasPrice = quantity(await rpc.request("eth_gasPrice"), "eth_gasPrice");
        priorityFee = baseFee !== null && gasPrice > baseFee ? gasPrice - baseFee : 0n;
      }
      if (baseFee === null) {
        // Pre-London chain: the gas price is the whole fee.
        return { baseFee: quantity(await rpc.request("eth_gasPrice"), "eth_gasPrice"), priorityFee: 0n, block: quantity(block.number, "number") };
      }
      return { baseFee, priorityFee, block: quantity(block.number, "number") };
    },
    /** @param {Address} address @returns {Promise<Hex | null>} eip712Domain() return data, or null if it reverts */
    async eip712Domain(address) {
      try {
        return hex(await rpc.request("eth_call", [{ to: address, data: EIP712_DOMAIN_CALLDATA }, "latest"]), "eth_call");
      } catch (error) {
        if (error instanceof RpcError) {
          return null;
        }
        throw error;
      }
    },
    /** @param {Hex} hash @param {number} fallbackChainId @returns {Promise<TxFacts | null>} */
    async transaction(hash, fallbackChainId) {
      const t = /** @type {Record<string, unknown> | null} */ (await rpc.request("eth_getTransactionByHash", [hash]));
      if (t === null) {
        return null;
      }
      const to = t["to"];
      return {
        hash: hex(t["hash"], "hash"),
        from: getAddress(hex(t["from"], "from")),
        to: to === null || to === undefined ? null : getAddress(hex(to, "to")),
        input: hex(t["input"], "input"),
        nonce: Number(quantity(t["nonce"], "nonce")),
        gas: quantity(t["gas"], "gas"),
        chainId: t["chainId"] === undefined || t["chainId"] === null ? fallbackChainId : Number(quantity(t["chainId"], "chainId")),
        type: t["type"] === undefined || t["type"] === null ? 0 : Number(quantity(t["type"], "type")),
        authorizationList: authorizations(t["authorizationList"]),
      };
    },
    /** @param {Hex} hash @returns {Promise<ReceiptFacts | null>} */
    async receipt(hash) {
      const r = /** @type {Record<string, unknown> | null} */ (await rpc.request("eth_getTransactionReceipt", [hash]));
      if (r === null) {
        return null;
      }
      const contractAddress = r["contractAddress"];
      return {
        success: quantity(r["status"], "status") === 1n,
        blockNumber: quantity(r["blockNumber"], "blockNumber"),
        contractAddress: contractAddress === null || contractAddress === undefined ? null : getAddress(hex(contractAddress, "contractAddress")),
        gasUsed: quantity(r["gasUsed"], "gasUsed"),
      };
    },
  };
}

/** @typedef {ReturnType<typeof reader>} Reader */
