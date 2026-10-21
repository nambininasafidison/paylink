// SPDX-License-Identifier: MIT
/**
 * The capture report (docs/runbooks/paypal.md "Capture run"): what PayPal's sandbox did, with no secret and no personal
 * data, so the owner can commit it or paste it to the team. PayPal's answers are reduced to their shape: every string is
 * replaced by `<string:N>` except the enumerated values the findings need (statuses, methods, types, error names and
 * issues, money values of the run's own synthetic invoices) and URLs, which keep their scheme and host and lose their
 * ids. The run's own keys, ids, emails, names and the merchant's profile never appear; the token and the credentials are
 * never read into the report at all.
 *
 * Owner: PayPal spine workstream.
 */

/** Members whose string values are kept when they look like codes or amounts. */
const KEPT = new Set([
  "status",
  "currency_code",
  "value",
  "method",
  "type",
  "event_type",
  "resource_type",
  "rel",
  "term_type",
  "verification_status",
  "token_type",
  "issue",
  "event_version",
  "resource_version",
  "created_by_flow",
  "location",
]);
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/u;
const ERROR_NAME = /^[A-Z][A-Z_]{2,63}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

/** A URL as scheme, host and a path whose id-like segments read `{id}`; anything unparsable is a plain string shape. */
export function urlShape(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `<string:${String(value.length)}>`;
  }
  const idLike = (segment: string): string => (/\d/u.test(segment) && segment.length >= 8 ? "{id}" : segment);
  const path = url.pathname.split("/").map(idLike).join("/");
  const fragment = url.hash === "" ? "" : `#${idLike(url.hash.slice(1))}`;
  return `${url.protocol}//${url.host}${path}${url.search === "" ? "" : "?{query}"}${fragment}`;
}

/** `value` reduced to its shape (see the module comment). `member` is the name it has in its parent. */
export function redact(value: unknown, member: string | null = null): unknown {
  if (typeof value === "string") {
    if (member !== null && /(?:^|_)(?:url|href)$/u.test(member)) {
      return urlShape(value);
    }
    if (member === "name" && ERROR_NAME.test(value)) {
      return value;
    }
    if (member !== null && KEPT.has(member) && CODE.test(value)) {
      return value;
    }
    if (ISO_TIME.test(value)) {
      return "<date-time>";
    }
    if (ISO_DATE.test(value)) {
      return "<date>";
    }
    return `<string:${String(value.length)}>`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, member));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)]));
  }
  return value;
}

/** The dotted paths of an object's members (array items as `[]`), for an event's shape. */
export function paths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.length === 0 ? [`${prefix}[]`] : paths(value[0], `${prefix}[]`);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return typeof item === "object" && item !== null ? [path, ...paths(item, path)] : [path];
    });
  }
  return [];
}

/** How one step went: PayPal's answer as a code, never as prose. */
export type StepOutcome = { readonly result: "ok"; readonly status: number | null } | { readonly result: "refused"; readonly status: number; readonly name: string | null; readonly issue: string | null; readonly debugId: string | null } | { readonly result: "no-answer" } | { readonly result: "skipped"; readonly reason: string };

export interface CaptureStep {
  readonly id: string;
  readonly operation: string;
  readonly outcome: StepOutcome;
  /** The answer's shape (redacted), when there was one. */
  readonly answer?: unknown;
}

/** What the capture establishes, one member per UNVERIFIED behaviour of docs/paypal/SPEC.md §7 (and D1, §17.2). */
export interface CaptureFindings {
  readonly tokenLifetimeSeconds: number | null;
  readonly tokenScopes: readonly string[];
  readonly createWithDueDateOnly: string;
  readonly createWithTermTypeAndDueDate: string;
  readonly createWithoutEmail: string;
  readonly sendAnswer: string;
  readonly statusAfterShare: string | null;
  readonly shareWithoutEmail: string;
  readonly recipientViewUrl: string | null;
  readonly referenceSearch: "exact" | "partial" | "unknown";
  readonly remindWithEmail: string;
  readonly remindWithoutEmail: string;
  readonly payerPayment: string;
  readonly statusAfterPayerPayment: string | null;
  readonly payerTransaction: { readonly type: string | null; readonly method: string | null } | null;
  readonly webhookEventPaths: readonly string[] | null;
  readonly statusAfterRecord: string | null;
  readonly recordNote: "exact" | "changed" | "absent" | "not-run";
  readonly paymentIdShape: { readonly length: number; readonly pattern: boolean } | null;
  readonly undoWithPaymentId: string;
  readonly statusAfterUndo: string | null;
  readonly cancelAfterUndo: string;
  readonly statusAfterCancel: string | null;
}

export interface CaptureReport {
  readonly tool: "paylink-api capture";
  readonly format: 1;
  readonly ranAt: string;
  /** Scheme and host of the REST base: the sandbox, never live. */
  readonly base: string;
  readonly credentials: { readonly clientId: "present"; readonly clientSecret: "present"; readonly webhookId: "present" | "absent" };
  readonly findings: CaptureFindings;
  readonly steps: readonly CaptureStep[];
  /** What the owner checks by hand, with what to record. */
  readonly manual: readonly string[];
}
