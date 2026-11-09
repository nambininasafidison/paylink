// SPDX-License-Identifier: MIT
/**
 * "Was I really paid?" for the Mezo edition (Wave 2; docs/research/mezo-survey-2026-11.md: fake payment proofs and
 * "I paid" without a payment are what the surveyed freelancers met). The merchant pastes what a client sent: a message,
 * the text of a screenshot, a transaction hash, a PayLink link or receipt link. The message is **data**: code extracts
 * what it names (hashes, PayLink links, amounts in MUSD, dollars, BTC or sats), never a model, and the verdict comes
 * from Mezo testnet alone, through the app's chain client and registry:
 *
 * | Verdict        | When                                                                                          |
 * |----------------|-----------------------------------------------------------------------------------------------|
 * | `paid`         | a `Paid` event of the registry's PayLinkV2 names this merchant as payee (the transaction's receipt, a receipt link re-verified, or `stateOf` of one of the merchant's invoices) |
 * | `pending`      | nothing paid, and a transaction the message names is known to the node but not in a block yet  |
 * | `unknown`      | nothing paid or pending, and the chain did not answer (`unavailable`), or the message names nothing the chain can check (`nothing`) |
 * | `not-received` | everything the message names was read, and none of it is a payment to this merchant           |
 *
 * A payment to this merchant for another invoice than the one the message links (an old receipt sent again) is not a
 * payment of that invoice. Amounts the message claims are compared with what the chain shows (`amountMismatch`), never
 * believed. The same rules as the PayPal edition's `POST /v1/check` (apps/api/src/reconciler/check.ts on branch
 * `paypal`), with the chain as the only source and no server: the text never leaves this device, only the hashes and
 * keys it names reach Mezo testnet's RPC.
 */
import type { Registry, Token } from "@paylink/chains";
import { decodeInvoiceFragment, decodePaidLog, decodeReceiptFragment, PAID_TOPIC, readLinkState, verifyReceipt } from "@paylink/sdk";
import type { DecodedInvoiceLink, DecodedReceiptLink, LogLike, PaidEvent } from "@paylink/sdk";
import { isAddressEqual, parseUnits, TransactionReceiptNotFoundError } from "viem";
import type { Address, Hex, RpcLog } from "viem";
import type { ChainClient } from "../../core/clients.ts";
import { findInWindow } from "../../read/history.ts";

/** Longest message read (characters); the rest is ignored. */
export const CHECK_MAX_TEXT = 4_000;
/** Hashes, links and invoices read per check at most (each costs a few RPC calls). */
export const CHECK_MAX_ITEMS = 5;

/** What an amount in the message is in: MUSD, BTC (sats included), or plain dollars (compared with MUSD, a dollar). */
export type ClaimUnit = "MUSD" | "BTC" | "USD";

export interface ClaimedAmount {
  readonly unit: ClaimUnit;
  /** The amount as a plain decimal ("12.5"), in the unit (sats are converted to BTC). */
  readonly value: string;
  /** In 18-decimal base units (MUSD and BTC both have 18 decimals on Mezo). */
  readonly base: bigint;
}

/** A PayLink-shaped link: `…/pay/#…` or `…/till/#…` (an invoice) or `…/r/#…` (a receipt). */
export interface PayLinkRef {
  readonly kind: "invoice" | "receipt";
  readonly host: string;
  readonly fragment: string;
}

export interface Extracted {
  /** `0x` + 64 hex digits, lowercase, outside PayLink links: transaction hashes, or invoice keys. */
  readonly hashes: readonly Hex[];
  readonly links: readonly PayLinkRef[];
  readonly amounts: readonly ClaimedAmount[];
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'()[\]{}]+/giu;
const HASH = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{64}(?![0-9A-Za-z])/gu;
const NUM = String.raw`(?:\d{1,3}(?:[, \u00a0\u202f]\d{3})+|\d{1,24})(?:[.,]\d{1,18})?`;
const AMOUNT = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(?<pre>us\$|\$|usd|musd|btc)\s?(?<n1>${NUM})(?![\p{N}])|(?<n2>${NUM})\s?(?<post>musd|tbtc|btc|bitcoins?|satoshis?|sats?|usd|us\$|dollars?|dolara|\$)(?![\p{L}\p{N}]))`,
  "giu",
);

/**
 * A number as people type it, to a plain decimal: "1,250.50" and "1 250,50" are 1250.5, "12,50" is 12.5, "1,250" is
 * 1250 (a comma followed by groups of three digits groups thousands). `null` when it is not a number.
 */
export function decimalOf(raw: string): string | null {
  const text = raw.replace(/[ \u00a0\u202f]/gu, "");
  const dot = text.lastIndexOf(".");
  const comma = text.lastIndexOf(",");
  let whole = text;
  let fraction = "";
  if (dot >= 0 || comma >= 0) {
    const sep = /^\d{1,3}(?:,\d{3})+$/u.test(text) ? -1 : Math.max(dot, comma);
    whole = (sep === -1 ? text : text.slice(0, sep)).replace(/[.,]/gu, "");
    fraction = sep === -1 ? "" : text.slice(sep + 1);
  }
  if (!/^\d+$/u.test(whole) || !/^\d*$/u.test(fraction)) {
    return null;
  }
  const w = whole.replace(/^0+(?=\d)/u, "");
  const f = fraction.replace(/0+$/u, "");
  return f === "" ? w : `${w}.${f}`;
}

function unitOf(word: string): { readonly unit: ClaimUnit; readonly sats: boolean } {
  const lower = word.toLowerCase();
  if (lower === "musd") {
    return { unit: "MUSD", sats: false };
  }
  if (lower.startsWith("sat")) {
    return { unit: "BTC", sats: true };
  }
  if (lower === "btc" || lower === "tbtc" || lower.startsWith("bitcoin")) {
    return { unit: "BTC", sats: false };
  }
  return { unit: "USD", sats: false };
}

/** The amounts a text names in MUSD, dollars, BTC or sats, in order, without repeats. */
export function claimedAmounts(text: string): ClaimedAmount[] {
  const out: ClaimedAmount[] = [];
  for (const match of text.matchAll(AMOUNT)) {
    const groups = match.groups ?? {};
    const raw = groups["n1"] ?? groups["n2"] ?? "";
    const { unit, sats } = unitOf(groups["pre"] ?? groups["post"] ?? "");
    const decimal = decimalOf(raw);
    if (decimal === null) {
      continue;
    }
    let base: bigint;
    let value = decimal;
    try {
      base = parseUnits(decimal, sats ? 10 : 18);
      if (sats) {
        value = decimalOf(formatBase(base, 18)) ?? decimal;
      }
    } catch {
      continue;
    }
    if (base > 0n && !out.some((a) => a.unit === unit && a.base === base)) {
      out.push({ unit, value, base });
    }
  }
  return out;
}

/** `base` units of a token with `decimals` as a plain decimal ("12.5"). */
function formatBase(base: bigint, decimals: number): string {
  const text = base.toString().padStart(decimals + 1, "0");
  const fraction = text.slice(text.length - decimals).replace(/0+$/u, "");
  const whole = text.slice(0, text.length - decimals);
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/** The PayLink link a URL is, by its path (`pay/`, `till/` or `r/` with a fragment), or `null`. */
function payLinkOf(raw: string): PayLinkRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hash = raw.indexOf("#");
  const fragment = hash === -1 ? "" : raw.slice(hash + 1);
  const route = /(?:^|\/)(pay|till|r)\/?$/u.exec(url.pathname)?.[1];
  if (fragment === "" || route === undefined) {
    return null;
  }
  return { kind: route === "r" ? "receipt" : "invoice", host: url.host.toLowerCase(), fragment };
}

/** What a pasted text names, by code only (module comment). */
export function extract(text: string): Extracted {
  const slice = text.slice(0, CHECK_MAX_TEXT);
  const links: PayLinkRef[] = [];
  const rest: string[] = [];
  let outside = slice;
  for (const match of slice.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(/[.,;:!?]+$/u, "");
    const link = payLinkOf(raw);
    if (link === null) {
      // Another page's link (an explorer's /tx/0x…): only the hashes in it count.
      rest.push(raw);
    } else if (!links.some((l) => l.fragment === link.fragment)) {
      links.push(link);
    }
    outside = outside.replace(match[0], " ");
  }
  const hashes = [...`${outside} ${rest.join(" ")}`.matchAll(HASH)].map((m) => m[0].toLowerCase() as Hex);
  return { hashes: [...new Set(hashes)], links, amounts: claimedAmounts(outside) };
}

/** Where a finding comes from: a transaction hash, a receipt link, an invoice (link or key), or an amount alone. */
export type FindingSource = "transaction" | "receipt" | "invoice" | "amount";

export type Finding =
  | {
      readonly kind: "paid";
      readonly source: FindingSource;
      readonly key: Hex;
      /** This payment's amount (a transaction or receipt), or every payment's total (an invoice). */
      readonly amount: bigint;
      readonly token: Token;
      readonly payments: number;
      readonly txHash: Hex | null;
      readonly blockNumber: bigint | null;
      /** Unix seconds of the block (the last payment's, for an invoice). */
      readonly timestamp: bigint;
      readonly payer: Address | null;
      readonly memo: string | null;
    }
  /** Paid, or an invoice, but for someone else: `payee` is not this merchant. */
  | { readonly kind: "other-payee"; readonly source: FindingSource; readonly ref: Hex; readonly payee: Address }
  /** A payment to this merchant, for another invoice than the one the message links. */
  | { readonly kind: "other-invoice"; readonly ref: Hex; readonly key: Hex; readonly memo: string | null }
  | { readonly kind: "unpaid"; readonly source: FindingSource; readonly key: Hex; readonly cancelled: boolean; readonly memo: string | null }
  | { readonly kind: "no-tx" | "pending" | "reverted" | "not-paylink"; readonly ref: Hex }
  /** A receipt link the chain contradicts; `i18nKey` and `params` say how (the SDK's receipt failure). */
  | { readonly kind: "forged"; readonly ref: Hex; readonly i18nKey: string; readonly params: Readonly<Record<string, string>> }
  /** A PayLink-shaped link that is not a valid Mezo testnet one (altered, cut, or another network's). */
  | { readonly kind: "bad-link"; readonly host: string }
  | { readonly kind: "unavailable"; readonly ref: string };

export type Verdict = "paid" | "not-received" | "pending" | "unknown";

export interface CheckResult {
  readonly verdict: Verdict;
  /** Why `unknown`: the chain did not answer, or there was nothing to check. */
  readonly reason: "unavailable" | "nothing" | null;
  readonly findings: readonly Finding[];
  readonly claimed: readonly ClaimedAmount[];
  /** The message claims amounts and no payment found is one of them. */
  readonly amountMismatch: boolean;
  /** Hosts of PayLink links in the message that are not this site's. */
  readonly foreignHosts: readonly string[];
}

export type CheckClient = Pick<ChainClient, "chain" | "call" | "getBlock" | "getBlockNumber" | "getLogs" | "getTransactionReceipt" | "getTransaction">;

export interface CheckContext {
  readonly registry: Registry;
  readonly chainId: number;
  readonly client: CheckClient;
  /** The merchant: the connected wallet, the payee of their invoices. */
  readonly merchant: Address;
  /** The merchant's invoices on this device, on `chainId` (keys and amounts named without a link). */
  readonly invoices: readonly DecodedInvoiceLink[];
  /** This site's host (`app.site.origin`'s): PayLink links elsewhere are flagged. */
  readonly host: string;
}

/** Kinds that mean "read, and not a payment to you". */
const CHECKED: ReadonlySet<Finding["kind"]> = new Set(["other-payee", "other-invoice", "unpaid", "no-tx", "reverted", "not-paylink", "forged"]);

/** True when `claim` is `amount` of `token` (MUSD and dollars compare with a dollar token, BTC with the native coin). */
export function claimMatches(claim: ClaimedAmount, token: Token, amount: bigint): boolean {
  const native = token.kind === "native";
  if ((claim.unit === "BTC") !== native || token.decimals > 18) {
    return false;
  }
  const scale = 10n ** BigInt(18 - token.decimals);
  return claim.base % scale === 0n && claim.base / scale === amount;
}

function toLogLike(log: RpcLog): LogLike {
  return { address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex === null ? null : Number(BigInt(log.logIndex)) };
}

/** Reads the chain for one message (module comment). Transport failures become `unavailable` findings, never a verdict. */
export async function checkPayment(text: string, context: CheckContext): Promise<CheckResult> {
  const { registry, chainId, client, merchant, invoices } = context;
  const found = extract(text);
  const foreignHosts = [...new Set(found.links.map((l) => l.host).filter((host) => host !== context.host.toLowerCase()))];
  const target = registry.v2Target(chainId);
  const findings: Finding[] = [];
  if (target === undefined) {
    return { verdict: "unknown", reason: "unavailable", findings: [{ kind: "unavailable", ref: String(chainId) }], claimed: found.amounts, amountMismatch: false, foreignHosts };
  }
  const contract = target.deployment.address;
  const memoOf = (key: Hex): string | null => invoices.find((i) => i.key === key)?.memo ?? null;
  /** Invoice keys the message claims are paid (an invoice link or key; a receipt's own invoice is what it proves). */
  const named = new Set<Hex>();
  const items: { readonly ref: string; readonly run: () => Promise<Finding> }[] = [];

  /** A transaction hash the chain has no receipt for: pending, made up, or the RPC lagging. */
  const missing = async (hash: Hex): Promise<Finding> => {
    const tx = client.getTransaction === undefined ? null : await client.getTransaction(hash);
    return tx === null ? { kind: "no-tx", ref: hash } : tx.blockNumber === null ? { kind: "pending", ref: hash } : { kind: "unavailable", ref: hash };
  };

  const paidFinding = async (event: Pick<PaidEvent, "key" | "amount" | "payer">, source: FindingSource, hash: Hex, blockNumber: bigint, token: Token, timestamp?: bigint): Promise<Finding> => ({
    kind: "paid",
    source,
    key: event.key,
    amount: event.amount,
    token,
    payments: 1,
    txHash: hash,
    blockNumber,
    timestamp: timestamp ?? (await client.getBlock({ blockNumber })).timestamp,
    payer: event.payer,
    memo: memoOf(event.key),
  });

  const checkTransaction = async (hash: Hex): Promise<Finding> => {
    let receipt: Awaited<ReturnType<CheckClient["getTransactionReceipt"]>>;
    try {
      receipt = await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) {
        return await missing(hash);
      }
      throw error;
    }
    if (receipt.status !== "success") {
      return { kind: "reverted", ref: hash };
    }
    const events = receipt.logs
      .filter((log) => log.address.toLowerCase() === contract.toLowerCase() && log.topics[0]?.toLowerCase() === PAID_TOPIC)
      .map((log) => decodePaidLog({ address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex }))
      .filter((event): event is PaidEvent => event !== null && registry.findToken(chainId, event.token) !== undefined);
    const first = events[0];
    if (first === undefined) {
      return { kind: "not-paylink", ref: hash };
    }
    const mine = events.find((event) => isAddressEqual(event.payee, merchant));
    if (mine === undefined) {
      return { kind: "other-payee", source: "transaction", ref: hash, payee: first.payee };
    }
    const token = registry.findToken(chainId, mine.token);
    return token === undefined ? { kind: "not-paylink", ref: hash } : await paidFinding(mine, "transaction", hash, receipt.blockNumber, token);
  };

  const checkReceipt = async (link: DecodedReceiptLink): Promise<Finding> => {
    const verification = await verifyReceipt({ registry, client, reference: link, ...(link.invoice === null ? {} : { paid: link.invoice }) });
    if (!verification.valid) {
      if (verification.failure === "not-found") {
        return await missing(link.txHash);
      }
      return verification.failure === "transaction-reverted"
        ? { kind: "reverted", ref: link.txHash }
        : { kind: "forged", ref: link.txHash, i18nKey: verification.i18nKey, params: verification.params };
    }
    const { proof } = verification;
    if (!isAddressEqual(proof.payee, merchant)) {
      return { kind: "other-payee", source: "receipt", ref: link.txHash, payee: proof.payee };
    }
    const finding = await paidFinding(proof, "receipt", link.txHash, proof.blockNumber, proof.tokenInfo, proof.timestamp);
    return finding.kind === "paid" && proof.memo !== null ? { ...finding, memo: proof.memo } : finding;
  };

  const checkInvoice = async (link: DecodedInvoiceLink, source: FindingSource): Promise<Finding> => {
    if (!isAddressEqual(link.invoice.payee, merchant)) {
      return { kind: "other-payee", source, ref: link.key, payee: link.invoice.payee };
    }
    const state = await readLinkState(client, contract, link.key);
    if (state.payments === 0) {
      return { kind: "unpaid", source, key: link.key, cancelled: state.cancelled, memo: link.memo };
    }
    // The last payment's block and transaction: the blocks stamped at `lastPaidAt`. Not found or not answered, the
    // payment stands (stateOf says so) without them.
    let log: RpcLog | null;
    try {
      log = await findInWindow(client, client.chain, { address: contract, topics: [PAID_TOPIC, link.key] }, { opens: state.lastPaidAt, closes: state.lastPaidAt + 1n, after: null }, (l) =>
        Promise.resolve(decodePaidLog(toLogLike(l)) === null ? null : l),
      );
    } catch {
      log = null;
    }
    return {
      kind: "paid",
      source,
      key: link.key,
      amount: state.total,
      token: link.token,
      payments: state.payments,
      txHash: log?.transactionHash ?? null,
      blockNumber: log?.blockNumber === null || log?.blockNumber === undefined ? null : BigInt(log.blockNumber),
      timestamp: state.lastPaidAt,
      payer: log === null ? null : (decodePaidLog(toLogLike(log))?.payer ?? null),
      memo: link.memo,
    };
  };

  for (const link of found.links) {
    try {
      if (link.kind === "invoice") {
        const decoded = decodeInvoiceFragment(link.fragment, registry);
        if (decoded.chainId !== chainId) {
          throw new Error("another chain");
        }
        named.add(decoded.key);
        items.push({ ref: decoded.key, run: async () => await checkInvoice(decoded, "invoice") });
      } else {
        const decoded = decodeReceiptFragment(link.fragment, registry);
        if (decoded.chainId !== chainId) {
          throw new Error("another chain");
        }
        items.push({ ref: decoded.txHash, run: async () => await checkReceipt(decoded) });
      }
    } catch {
      findings.push({ kind: "bad-link", host: link.host });
    }
  }
  for (const hash of found.hashes) {
    const own = invoices.find((i) => i.key === hash);
    if (own !== undefined) {
      named.add(own.key);
      items.push({ ref: hash, run: async () => await checkInvoice(own, "invoice") });
    } else if (!items.some((item) => item.ref === hash)) {
      items.push({ ref: hash, run: async () => await checkTransaction(hash) });
    }
  }
  if (items.length === 0 && findings.length === 0) {
    // Only amounts: the merchant's fixed-amount invoices of that amount, newest first.
    for (const own of invoices.filter((i) => i.invoice.amount > 0n && found.amounts.some((a) => claimMatches(a, i.token, i.invoice.amount)))) {
      items.push({ ref: own.key, run: async () => await checkInvoice(own, "amount") });
    }
  }
  // One after another: public RPCs limit bursts.
  for (const item of items.slice(0, CHECK_MAX_ITEMS)) {
    try {
      findings.push(await item.run());
    } catch {
      findings.push({ kind: "unavailable", ref: item.ref });
    }
  }
  // A payment to this merchant for another invoice than the one linked is not that invoice's payment; a transaction
  // and the invoice it pays are one payment, shown once (the transaction's, with its own amount).
  const settled = findings.map((f): Finding => (f.kind === "paid" && f.source !== "invoice" && f.source !== "amount" && named.size > 0 && !named.has(f.key) ? { kind: "other-invoice", ref: f.txHash ?? f.key, key: f.key, memo: f.memo } : f));
  const byTransaction = new Set(settled.flatMap((f) => (f.kind === "paid" && (f.source === "transaction" || f.source === "receipt") ? [f.key] : [])));
  const final = settled.filter((f) => !(f.kind === "paid" && (f.source === "invoice" || f.source === "amount") && byTransaction.has(f.key)));
  const paid = final.filter((f): f is Extract<Finding, { kind: "paid" }> => f.kind === "paid");
  let verdict: Verdict;
  let reason: CheckResult["reason"] = null;
  if (paid.length > 0) {
    verdict = "paid";
  } else if (final.some((f) => f.kind === "pending")) {
    verdict = "pending";
  } else if (final.some((f) => f.kind === "unavailable")) {
    verdict = "unknown";
    reason = "unavailable";
  } else if (final.some((f) => CHECKED.has(f.kind))) {
    verdict = "not-received";
  } else {
    verdict = "unknown";
    reason = "nothing";
  }
  const amountMismatch = paid.length > 0 && found.amounts.length > 0 && !found.amounts.some((claim) => paid.some((p) => claimMatches(claim, p.token, p.amount)));
  return { verdict, reason, findings: final, claimed: found.amounts, amountMismatch, foreignHosts };
}
