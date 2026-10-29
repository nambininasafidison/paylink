// SPDX-License-Identifier: MIT
/**
 * "Was I really paid?" (Tonga ve?, `POST /v1/check`, docs/paypal/SPEC.md §9.2, §14.2 F6, invariant AI-6): a pasted
 * message is **data**. Code extracts what it names (PayLink invoice numbers and keys, dollar amounts, links), matches the
 * payee's own twins, reads each matching twin fresh (P5 and the chain, through the reconciler), and answers a verdict
 * that only those reads decide:
 *
 * | Verdict          | When                                                                                       |
 * |------------------|--------------------------------------------------------------------------------------------|
 * | `UNAVAILABLE`    | PayPal or the chain could not be read for a matching twin: "Can't check now", never a guess |
 * | `NOT_RECEIVED`   | no twin of the payee matches, or none of the matching twins is paid                         |
 * | `RECEIVED`       | a matching twin is paid (PayPal's verified GET or a verified chain payment), and every amount the message claims is a paid twin's amount |
 * | `PARTLY_RECEIVED`| some, not all, of what the message claims is paid; or PayPal reports the invoice partly paid |
 *
 * Links are listed with whether their host is one PayLink trusts (PayPal's own hosts, the pinned payer host, the
 * edition's origins); anything else, a look-alike included, is `allowed: false`. A3's reason codes are cut (D-SCOPE):
 * no model is called here.
 *
 * Owner: reconciler workstream.
 */
import type { Address, CheckResponse, CheckVerdict, InvoiceKey, Rail } from "@paylink/api-contract";
import type { ApiServices } from "../core/services.ts";
import { chargeQuota } from "../store/quotas.ts";
import type { TwinRecord } from "../store/types.ts";
import type { ChainObservation } from "./types.ts";
import { chainTwinOf, reconcileTwin } from "./engine.ts";
import { centsOf, usdFromBase } from "./money.ts";

/** Longest message checked (characters, E; the route's body limit is 16 KiB). */
export const CHECK_MAX_TEXT = 4_000;
/** Twins read per check at most (each costs one P5). */
export const CHECK_MAX_MATCHES = 5;
/** Links listed per check at most. */
export const CHECK_MAX_LINKS = 20;

/**
 * PayPal's own web hosts (E: the hosts of paypal.com and its sandbox, where invoices are paid). The sandbox's payer page
 * is on `www.sandbox.paypal.com` (C, the owner's capture run of 2026-10-29), pinned in configuration as `payerHost`.
 */
export const PAYPAL_HOSTS = ["paypal.com", "www.paypal.com", "sandbox.paypal.com", "www.sandbox.paypal.com"] as const;

const NUMBER = /\bPL-(?<chain>[1-9][0-9]{0,15})-(?<prefix>[0-9a-f]{12})\b/giu;
const KEY = /\b0x[0-9a-fA-F]{64}\b/gu;
const AMOUNT = /(?:(?:US\$|\$|USD\s?)\s?(?<a>[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?))|(?:(?<b>[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)\s?(?:USD|US dollars?|dollars?)\b)/giu;
const LINK = /\bhttps?:\/\/[^\s<>"'()]+/giu;

export interface Extracted {
  /** PayLink invoice numbers, lowercase (`pl-<chainId>-<12 hex>`). */
  readonly numbers: readonly string[];
  readonly keys: readonly InvoiceKey[];
  /** Amounts in cents. */
  readonly amounts: readonly bigint[];
  readonly links: readonly string[];
}

/** What the text names, by code only. */
export function extract(text: string): Extracted {
  const slice = text.slice(0, CHECK_MAX_TEXT);
  const numbers = [...slice.matchAll(NUMBER)].map((m) => `pl-${m.groups?.["chain"] ?? ""}-${(m.groups?.["prefix"] ?? "").toLowerCase()}`);
  const keys = [...slice.matchAll(KEY)].map((m) => m[0].toLowerCase() as InvoiceKey);
  const amounts = [...slice.matchAll(AMOUNT)].map((m) => centsOf((m.groups?.["a"] ?? m.groups?.["b"] ?? "").replaceAll(",", ""))).filter((c): c is bigint => c !== null && c > 0n);
  const links = [...slice.matchAll(LINK)].map((m) => m[0]).slice(0, CHECK_MAX_LINKS);
  return { numbers: [...new Set(numbers)], keys: [...new Set(keys)], amounts: [...new Set(amounts)], links };
}

/** The hosts a payee may trust in a message: PayPal's, the pinned payer host, the edition's own origins. */
export function trustedHosts(services: ApiServices): ReadonlySet<string> {
  const { config } = services.runtime;
  const hosts = new Set<string>([...PAYPAL_HOSTS, config.paypal.payerHost.toLowerCase()]);
  for (const origin of config.allowedOrigins) {
    try {
      hosts.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // not an origin: ignored
    }
  }
  return hosts;
}

function linkOf(raw: string, trusted: ReadonlySet<string>): { readonly host: string; readonly allowed: boolean } {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return { host, allowed: url.protocol === "https:" && url.username === "" && url.password === "" && trusted.has(host) };
  } catch {
    return { host: raw.slice(0, 100), allowed: false };
  }
}

/** The twins a message refers to: by number or key first; otherwise by an amount it claims. */
export function matchTwins(twins: readonly TwinRecord[], found: Extracted): TwinRecord[] {
  const byRef = twins.filter((t) => found.numbers.includes(t.invoiceNumber.toLowerCase()) || found.keys.includes(t.key));
  const matched = byRef.length > 0 ? byRef : twins.filter((t) => found.amounts.some((a) => a === centsOf(usdFromBase(t.amountBase))));
  return matched.sort((a, b) => b.createdAt - a.createdAt).slice(0, CHECK_MAX_MATCHES);
}

/** The deterministic verdict (module comment). */
export async function checkMessage(services: ApiServices, payee: Address, text: string, now: number): Promise<CheckResponse> {
  await chargeQuota(services, payee, "checks", now);
  const found = extract(text);
  const trusted = trustedHosts(services);
  const store = services.stores.payee(payee);
  const twins = matchTwins(await store.listTwins(), found);
  const chain: ReadonlyMap<InvoiceKey, ChainObservation> = twins.length === 0 ? new Map() : await services.chain.observeMany(twins.map(chainTwinOf));
  let paypalOk = true;
  let chainOk = true;
  let partial = false;
  const matches: { key: InvoiceKey; invoiceNumber: string; amount: string; paidOn: Rail[] }[] = [];
  for (const twin of twins) {
    const observation = chain.get(twin.key);
    // A check only reads: the automatic record waits for the cron or a sweep.
    const outcome = await reconcileTwin(services, payee, twin.key, now, { source: "check", automatic: false, ...(observation === undefined ? {} : { chain: observation }) });
    if (outcome.status !== "done") {
      paypalOk = false; // busy: not read now, so not known now
      continue;
    }
    const { result, twin: fresh } = outcome;
    if (result.alert === "paypal-unreadable") {
      paypalOk = false;
    }
    if (result.alert === "chain-unreadable" || result.alert === "chain-not-deployed") {
      chainOk = false;
    }
    const paidOn: Rail[] = [];
    if (result.paidVia === "PAYPAL" || result.situation === "S4") {
      paidOn.push("PAYPAL");
    }
    if (fresh.lastChainState === "paid" && fresh.chainPayment !== null) {
      paidOn.push(fresh.rail);
    }
    partial ||= fresh.lastStatus === "PARTIALLY_PAID";
    matches.push({ key: twin.key, invoiceNumber: twin.invoiceNumber, amount: usdFromBase(twin.amountBase) ?? "", paidOn });
  }
  const paidAmounts = new Set(matches.filter((m) => m.paidOn.length > 0).map((m) => centsOf(m.amount)));
  let verdict: CheckVerdict;
  if (!paypalOk || !chainOk) {
    verdict = "UNAVAILABLE";
  } else if (paidAmounts.size === 0) {
    verdict = partial ? "PARTLY_RECEIVED" : "NOT_RECEIVED";
  } else {
    const claimed = found.amounts.length === 0 ? matches.map((m) => centsOf(m.amount)) : found.amounts;
    verdict = claimed.every((a) => paidAmounts.has(a)) && !partial ? "RECEIVED" : "PARTLY_RECEIVED";
  }
  return {
    verdict,
    sources: { paypal: paypalOk ? "checked" : "unavailable", chain: chainOk ? "checked" : "unavailable" },
    matches,
    links: found.links.map((l) => linkOf(l, trusted)),
    checkedAt: new Date(now).toISOString(),
  };
}
