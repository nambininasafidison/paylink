// SPDX-License-Identifier: MIT
/** Shared values for the indexer tests: lowercase addresses, 32-byte keys and logs with sensible defaults. */
import type { CancelledLog, PaidLog } from "../src/ledger.ts";

export const MONAD = 10143;
export const BASE = 84532;

export const PAYEE = "0x1111111111111111111111111111111111111111";
export const PAYEE_2 = "0x2222222222222222222222222222222222222222";
export const PAYER = "0x3333333333333333333333333333333333333333";
export const PAYER_2 = "0x4444444444444444444444444444444444444444";
/** AUSD on Monad testnet, as config.yaml's lowercase address format delivers it. */
export const AUSD = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc";
export const OTHER_TOKEN = "0x5555555555555555555555555555555555555555";

export const KEY_A = `0x${"a1".repeat(32)}`;
export const KEY_B = `0x${"b2".repeat(32)}`;
export const REF = `0x${"00".repeat(32)}`;

/** 2026-10-09T00:00:00Z: day 20735. */
export const T0 = 1_791_504_000;
export const DAY = 86_400;

export const tx = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

export function paid(overrides: Partial<PaidLog> = {}): PaidLog {
  return {
    chainId: MONAD,
    key: KEY_A,
    payee: PAYEE,
    payer: PAYER,
    token: AUSD,
    amount: 1_000_000n,
    index: 0n,
    payerRef: REF,
    blockNumber: 69_400_000,
    timestamp: T0 + 600,
    txHash: tx(1),
    logIndex: 0,
    ...overrides,
  };
}

export function cancelled(overrides: Partial<CancelledLog> = {}): CancelledLog {
  return {
    chainId: MONAD,
    key: KEY_A,
    payee: PAYEE,
    blockNumber: 69_400_100,
    timestamp: T0 + 900,
    txHash: tx(99),
    logIndex: 0,
    ...overrides,
  };
}
