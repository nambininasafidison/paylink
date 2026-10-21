// SPDX-License-Identifier: MIT
/**
 * A whole world for the reconciler's end-to-end tests (L1): the API's real services over in-memory stores, with the
 * PayPal stand-in (./paypal-stub.ts) and Sepolia scripted behind a real viem client (../chain/sepolia.ts), a clock the
 * test moves, and helpers to register a twin and to change either rail.
 */
import type { Address, InvoiceKey } from "@paylink/api-contract";
import type { ApiServices } from "../../src/core/services.ts";
import { createServices } from "../../src/core/services.ts";
import type { NewTwin } from "../../src/store/types.ts";
import { createMemoryStores } from "../../src/store/memory.ts";
import { fakeChain, fakeReader } from "../chain/sepolia.ts";
import type { FakeChain } from "../chain/sepolia.ts";
import type { RpcFake } from "../chain/rpc.ts";
import { T0, testRuntime } from "../helpers.ts";
import { PAYEE, USDC } from "./fixtures.ts";
import { paypalStub } from "./paypal-stub.ts";
import type { PayPalStub } from "./paypal-stub.ts";

export const APPROVAL_KEY = "11".repeat(32);
export const SESSION_KEY = "22".repeat(32);

export interface World {
  readonly services: ApiServices;
  readonly paypal: PayPalStub;
  readonly chain: FakeChain;
  readonly rpc: RpcFake;
  readonly clock: { now: number };
  readonly lines: string[];
  /** A twin of $120.00 in USDC for `key`, shared on PayPal as `paypalId`, valid 7 days. */
  twin(key: InvoiceKey, paypalId: string, overrides?: Partial<NewTwin>): NewTwin;
  /** The chain records a payment of the twin (`stateOf` and its `Paid` log, 3 blocks deep). */
  payOnChain(key: InvoiceKey, txHash: `0x${string}`, options?: { readonly payee?: Address; readonly amount?: bigint }): void;
  cancelOnChain(key: InvoiceKey): void;
  /** Advances the clock (and the chain's) by `ms`. */
  advance(ms: number): void;
}

export function world(): World {
  const paypal = paypalStub();
  const chain = fakeChain(Math.floor(T0 / 1000));
  const { reader, rpc } = fakeReader(chain);
  const clock = { now: T0 };
  const lines: string[] = [];
  const base = testRuntime({ secrets: { approvalHmacKey: APPROVAL_KEY, sessionHmacKey: SESSION_KEY }, lines });
  const runtime = { ...base, clock: () => clock.now };
  const services: ApiServices = { ...createServices(runtime, createMemoryStores()), paypal: paypal.client, chain: reader };
  return {
    services,
    paypal,
    chain,
    rpc,
    clock,
    lines,
    twin: (key, paypalId, overrides = {}) => ({
      key,
      payee: PAYEE,
      chainId: 11155111,
      paypalId,
      invoiceNumber: `PL-11155111-${key.slice(2, 14)}`,
      amountBase: "120000000",
      token: USDC,
      rail: "USDC",
      validUntil: Math.floor(clock.now / 1000) + 7 * 86_400,
      recipientViewUrl: `https://www.sandbox.paypal.com/invoice/p/#${paypalId}`,
      hasRecipientEmail: true,
      dueDate: "2026-11-06",
      sentAt: clock.now,
      ...overrides,
    }),
    payOnChain: (key, txHash, options = {}) => {
      chain.states.set(key, { payments: 1, cancelled: false, lastPaidAt: BigInt(chain.time - 60) });
      chain.logs.push({ topic: "paid", key, payee: options.payee ?? PAYEE, token: USDC, amount: options.amount ?? 120_000_000n, txHash, block: chain.block - 2, logIndex: 1 });
    },
    cancelOnChain: (key) => {
      chain.states.set(key, { payments: 0, cancelled: true, lastPaidAt: 0n });
      chain.logs.push({ topic: "cancelled", key, payee: PAYEE, txHash: `0x${"cc".repeat(32)}`, block: chain.block - 1, logIndex: 0 });
    },
    advance: (ms) => {
      clock.now += ms;
      chain.time += Math.floor(ms / 1000);
      chain.block += Math.floor(ms / 12_000);
    },
  };
}
