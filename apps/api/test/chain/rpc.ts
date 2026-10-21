// SPDX-License-Identifier: MIT
/**
 * A scripted JSON-RPC endpoint behind a `fetch`, for the API's chain reads in tests: each call is answered by the
 * handler (a result, or an `RpcError` for a JSON-RPC error), and recorded, so a test can count requests (the cron's
 * one-multicall budget) and see the methods. No network.
 */

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RpcCall {
  readonly url: string;
  readonly method: string;
  readonly params: readonly unknown[];
}

export type RpcHandler = (method: string, params: readonly unknown[]) => unknown;

export interface RpcFake {
  readonly fetch: typeof fetch;
  readonly calls: RpcCall[];
}

export function rpcFake(handler: RpcHandler): RpcFake {
  const calls: RpcCall[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const text = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(text) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
    const answer = (request: { id: number; method: string; params?: unknown[] }): unknown => {
      const params = request.params ?? [];
      calls.push({ url, method: request.method, params });
      try {
        return { jsonrpc: "2.0", id: request.id, result: handler(request.method, params) };
      } catch (error) {
        if (error instanceof RpcError) {
          return { jsonrpc: "2.0", id: request.id, error: { code: error.code, message: error.message } };
        }
        throw error;
      }
    };
    const body = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
    return await Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  };
  return { fetch: fetchFn, calls };
}

/** A fetch that fails like a dead endpoint. */
export const deadFetch = ((): Promise<Response> => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
