// SPDX-License-Identifier: MIT
/** A programmable stand-in for viem's PublicClient: code per address, and `eth_call` answers per selector. */
import type { Address, Hex } from "viem";
import type { SignatureClient } from "../src/index.ts";

export type CallAnswer = Hex | Error | ((data: Hex) => Hex);

export interface MockClient extends SignatureClient {
  readonly calls: { to: Address; data: Hex }[];
}

export function mockClient(options: {
  readonly code?: Readonly<Record<string, Hex>>;
  /** Answers keyed by 4-byte selector, or by `*` for any call. */
  readonly answers?: Readonly<Record<string, CallAnswer>>;
}): MockClient {
  const calls: { to: Address; data: Hex }[] = [];
  return {
    calls,
    getCode: ({ address }) => Promise.resolve(options.code?.[address.toLowerCase()]),
    call: ({ to, data }) => {
      calls.push({ to, data });
      const answer = options.answers?.[data.slice(0, 10)] ?? options.answers?.["*"];
      if (answer === undefined) {
        return Promise.resolve({ data: undefined });
      }
      if (answer instanceof Error) {
        return Promise.reject(answer);
      }
      return Promise.resolve({ data: typeof answer === "function" ? answer(data) : answer });
    },
  };
}
