// SPDX-License-Identifier: MIT
/**
 * Receipt verification (invoice spec §12, threat T-43): proves that one `Paid` event exists on the canonical
 * deployment of a registry chain and reports exactly what it proves (payee, payer, token, amount, invoice
 * key), never a bare "valid". Only the chain is trusted, through the registry's RPCs; an indexer is never
 * consulted. Events in tokens off the registry allowlist prove nothing (self-review observation O-3) and are
 * refused.
 */
import type { Registry, Token } from "@paylink/chains";
import { getAddress, keccak256, TransactionReceiptNotFoundError } from "viem";
import type { Address, Hex } from "viem";
import { PAID_TOPIC } from "./constants.ts";
import { invoiceKey } from "./eip712.ts";
import type { SdkI18nKey } from "./i18n-keys.ts";
import { memoBytes } from "./memo.ts";
import type { Invoice, ReceiptReference, SignedInvoice } from "./types.ts";

/** A log as viem returns it inside a transaction receipt or from `eth_getLogs`. */
export interface LogLike {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly logIndex: number | null;
}

/** The part of a transaction receipt the verifier reads. viem's `TransactionReceipt` satisfies it. */
export interface ReceiptLike {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly logs: readonly LogLike[];
}

/** What the verifier needs from a chain. viem's `PublicClient` satisfies it. */
export interface ReceiptClient {
  getTransactionReceipt(parameters: { hash: Hex }): Promise<ReceiptLike>;
  getBlock(parameters: { blockNumber: bigint } | { blockTag: "finalized" }): Promise<{ readonly number: bigint | null; readonly timestamp: bigint }>;
}

/** The decoded fields of a `Paid` event (spec §7.3). */
export interface PaidEvent {
  readonly contract: Address;
  readonly key: Hex;
  readonly payee: Address;
  readonly payer: Address;
  readonly token: Address;
  readonly amount: bigint;
  readonly index: number;
  readonly payerRef: Hex;
  readonly logIndex: number | null;
}

/** Everything a valid receipt proves (spec §12 step 7). */
export interface ReceiptProof extends Omit<PaidEvent, "logIndex">, ReceiptReference {
  /** The allowlisted token, for its decimals and symbol. */
  readonly tokenInfo: Token;
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  /** `finalized` when the block is at or below the chain's finalized block; `confirmed` otherwise. */
  readonly finality: "finalized" | "confirmed";
  /** The paid invoice, when one was supplied and it matches the event. */
  readonly invoice: Invoice | null;
  readonly memo: string | null;
}

export type ReceiptFailure =
  | "chain-unknown"
  | "not-found"
  | "transaction-reverted"
  | "log-not-found"
  | "wrong-contract"
  | "not-paid-event"
  | "malformed-log"
  | "token-not-allowlisted"
  | "invoice-mismatch";

export type ReceiptVerification =
  | { readonly valid: true; readonly proof: ReceiptProof }
  | {
      readonly valid: false;
      readonly failure: ReceiptFailure;
      readonly i18nKey: SdkI18nKey;
      readonly params: Readonly<Record<string, string>>;
    };

const FAILURE_KEYS: Readonly<Record<ReceiptFailure, SdkI18nKey>> = {
  "chain-unknown": "error.receipt.chainUnknown",
  "not-found": "error.receipt.notFound",
  "transaction-reverted": "error.receipt.transactionReverted",
  "log-not-found": "error.receipt.logNotFound",
  "wrong-contract": "error.receipt.wrongContract",
  "not-paid-event": "error.receipt.notPaidEvent",
  "malformed-log": "error.receipt.malformedLog",
  "token-not-allowlisted": "error.receipt.tokenNotAllowlisted",
  "invoice-mismatch": "error.receipt.invoiceMismatch",
};

const invalid = (failure: ReceiptFailure, params: Record<string, string> = {}): ReceiptVerification => ({
  valid: false,
  failure,
  i18nKey: FAILURE_KEYS[failure],
  params,
});

const WORD = /^0x[0-9a-f]{64}$/;
const DATA = /^0x[0-9a-f]{256}$/;
const zeros = (n: number): string => "0".repeat(n);

/** A 32-byte topic holding an address: the high 12 bytes must be zero (spec §12 step 4). */
function topicAddress(topic: string): Address | null {
  const lower = topic.toLowerCase();
  return WORD.test(lower) && lower.startsWith(`0x${zeros(24)}`) ? getAddress(`0x${lower.slice(26)}`) : null;
}

/**
 * Decodes a `Paid` log strictly (spec §12 steps 3 and 4): four topics with the `Paid` topic first, exactly
 * 128 bytes of data, and no dirty high-order bits in any word. Returns `null` for anything else.
 */
export function decodePaidLog(log: LogLike): PaidEvent | null {
  const [topic0, keyTopic, payeeTopic, payerTopic] = log.topics;
  const data = log.data.toLowerCase();
  if (log.topics.length !== 4 || topic0?.toLowerCase() !== PAID_TOPIC || keyTopic === undefined || !WORD.test(keyTopic.toLowerCase()) || !DATA.test(data)) {
    return null;
  }
  const payee = topicAddress(payeeTopic ?? "");
  const payer = topicAddress(payerTopic ?? "");
  const word = (i: number): string => data.slice(2 + 64 * i, 66 + 64 * i);
  const [tokenWord, amountWord, indexWord, refWord] = [word(0), word(1), word(2), word(3)];
  if (payee === null || payer === null || !tokenWord.startsWith(zeros(24)) || !amountWord.startsWith(zeros(32)) || !indexWord.startsWith(zeros(56))) {
    return null;
  }
  return {
    contract: getAddress(log.address),
    key: keyTopic.toLowerCase() as Hex,
    payee,
    payer,
    token: getAddress(`0x${tokenWord.slice(24)}`),
    amount: BigInt(`0x${amountWord}`),
    index: Number(BigInt(`0x${indexWord}`)),
    payerRef: `0x${refWord}`,
    logIndex: log.logIndex,
  };
}

/** Which field of a supplied invoice disagrees with the event, or `null` when it matches (spec §12 step 5). */
export function invoiceMismatch(event: PaidEvent, chainId: number, paid: SignedInvoice): "chain" | "key" | "payee" | "token" | "amount" | "memo" | null {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  if (paid.chainId !== chainId) {
    return "chain";
  }
  if (invoiceKey({ chainId, verifyingContract: event.contract }, paid.invoice) !== event.key) {
    return "key";
  }
  if (!same(paid.invoice.payee, event.payee)) {
    return "payee";
  }
  if (!same(paid.invoice.token, event.token)) {
    return "token";
  }
  if (paid.invoice.amount !== 0n && paid.invoice.amount !== event.amount) {
    return "amount";
  }
  if (paid.memo !== null && keccak256(memoBytes(paid.memo)) !== paid.invoice.memoHash) {
    return "memo";
  }
  return null;
}

/**
 * Verifies a receipt reference against the registry and a client for its chain (spec §12). Returns what
 * the receipt proves, or why it proves nothing. Transport failures are thrown: "could not check" is never
 * reported as "invalid", and never as "valid".
 */
export async function verifyReceipt(parameters: {
  readonly registry: Registry;
  readonly client: ReceiptClient;
  readonly reference: ReceiptReference;
  readonly paid?: SignedInvoice;
}): Promise<ReceiptVerification> {
  const { registry, client, reference, paid } = parameters;
  // 1. Chain and canonical deployment.
  const target = registry.v2Target(reference.chainId);
  if (target === undefined) {
    return invalid("chain-unknown", { chainId: String(reference.chainId) });
  }
  // 2. The receipt exists and succeeded.
  let receipt: ReceiptLike;
  try {
    receipt = await client.getTransactionReceipt({ hash: reference.txHash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      return invalid("not-found");
    }
    throw error;
  }
  if (receipt.status !== "success") {
    return invalid("transaction-reverted");
  }
  // 3. The log at logIndex, emitted by the canonical deployment, is a well-formed Paid event.
  const log = receipt.logs.find((l) => l.logIndex === reference.logIndex);
  if (log === undefined) {
    return invalid("log-not-found");
  }
  if (log.address.toLowerCase() !== target.deployment.address.toLowerCase()) {
    return invalid("wrong-contract");
  }
  if (log.topics[0]?.toLowerCase() !== PAID_TOPIC) {
    return invalid("not-paid-event");
  }
  // 4. Decoded fields.
  const event = decodePaidLog(log);
  if (event === null) {
    return invalid("malformed-log");
  }
  const tokenInfo = registry.findToken(reference.chainId, event.token);
  if (tokenInfo === undefined) {
    return invalid("token-not-allowlisted", { token: event.token });
  }
  // 5. The supplied invoice matches.
  if (paid !== undefined) {
    const field = invoiceMismatch(event, reference.chainId, paid);
    if (field !== null) {
      return invalid("invoice-mismatch", { field });
    }
  }
  // 6. Block time and finality.
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  let finality: "finalized" | "confirmed" = "confirmed";
  try {
    const finalized = await client.getBlock({ blockTag: "finalized" });
    finality = finalized.number !== null && finalized.number >= receipt.blockNumber ? "finalized" : "confirmed";
  } catch {
    // Chains without the `finalized` tag: report "confirmed".
  }
  return {
    valid: true,
    proof: {
      ...event,
      chainId: reference.chainId,
      txHash: reference.txHash,
      logIndex: reference.logIndex,
      tokenInfo,
      blockNumber: receipt.blockNumber,
      timestamp: block.timestamp,
      finality,
      invoice: paid?.invoice ?? null,
      memo: paid?.memo ?? null,
    },
  };
}

/** A reusable verifier bound to a registry, with one client per chain (spec §12, §13.4). */
export interface ReceiptVerifier {
  verify(reference: ReceiptReference, paid?: SignedInvoice): Promise<ReceiptVerification>;
}

export function createReceiptVerifier(options: {
  readonly registry: Registry;
  /** A client for the chain's registry RPCs (for example viem with `rpcTransport(chain)`). */
  readonly clientFor: (chainId: number) => ReceiptClient;
}): ReceiptVerifier {
  return {
    verify: async (reference, paid) =>
      await verifyReceipt({
        registry: options.registry,
        client: options.clientFor(reference.chainId),
        reference,
        ...(paid === undefined ? {} : { paid }),
      }),
  };
}

/**
 * The payment-arrival rule for a till (spec §13.4, threat T-44): when an invoice is armed, signal only for a
 * verified `Paid` with its key and, for a fixed invoice, exactly its amount. For open amounts and receive
 * cards, any amount matches, so the till must show `proof.amount` in large digits next to the signal.
 */
export function isPaymentForArmedInvoice(proof: ReceiptProof, armed: { readonly key: Hex; readonly invoice: Invoice }): boolean {
  return proof.key === armed.key.toLowerCase() && (armed.invoice.amount === 0n || proof.amount === armed.invoice.amount);
}
