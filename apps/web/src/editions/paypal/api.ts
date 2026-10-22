// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's client for its API (`apps/api`, docs/paypal/SPEC.md §13 with the decisions of 2026-10-21), typed
 * from `@paylink/api-contract`: the route table (`API_ROUTES`), the request and response types, the RFC 9457 problems
 * (`API_PROBLEMS`) and the session header.
 *
 * The API is trusted for availability and advice only (§6.5): every answer is checked against its shape before the
 * page reads it (plain checks, not zod: the pay route's shared code must not grow), a code the page does not know is
 * kept as a string and rendered with a generic fixed sentence, and no answer ever names an address, a token or an
 * amount the page signs. Text from the API is set with `textContent` (`h()`), never parsed as markup. Requests carry
 * no cookie and no referrer; the session token travels only in the `Authorization` header of session routes.
 *
 * Owner: web edition workstream.
 */
import { API_PROBLEMS, API_ROUTES, INVOICE_KEY_PATTERN, SESSION_HEADER } from "@paylink/api-contract";
import type {
  ApiProblemCode,
  ApiRouteId,
  ApproveRequest,
  ApproveResponse,
  CheckRequest,
  CheckResponse,
  DeskResponse,
  DeskSweepResponse,
  DraftRequest,
  DraftResponse,
  HealthResponse,
  InvoiceKey,
  RailsResponse,
  RejectResponse,
  SessionRequest,
  SessionResponse,
  TwinCreateRequest,
  TwinView,
  UndoResponse,
} from "@paylink/api-contract";

/** How long a read may take before the page says the API did not answer; writes to PayPal get longer. */
export const READ_TIMEOUT_MS = 10_000;
export const WRITE_TIMEOUT_MS = 30_000;

/** Why a call failed: an RFC 9457 problem from the API, no answer at all, or an answer that is not the contract's. */
export class ApiError extends Error {
  /** HTTP status; 0 when nothing came back. */
  readonly status: number;
  readonly code: ApiProblemCode | "network" | "timeout" | "invalid-response";
  /** The specification's rule (`E_STALE`, `E_TWIN_PRECISION`, …), when the problem names one. */
  readonly rule: string | null;
  readonly retryAfter: number | null;

  constructor(status: number, code: ApiError["code"], rule: string | null = null, retryAfter: number | null = null) {
    super(rule ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.rule = rule;
    this.retryAfter = retryAfter;
  }
}

// ------------------------------------------------------------------------------------------- shapes

/**
 * A check of one value's shape. Shapes are built when an answer is read, never at module load: the module has no
 * top-level effect, so a build that does not call it drops it whole (the other editions' pages import it unused).
 */
type Shape = (value: unknown) => boolean;

const text =
  (max: number, pattern?: RegExp): Shape =>
  (v) =>
    typeof v === "string" && v.length <= max && (pattern === undefined || pattern.test(v));
const num: Shape = (v) => typeof v === "number" && Number.isFinite(v);
const bool: Shape = (v) => typeof v === "boolean";
const oneOf =
  (...values: readonly unknown[]): Shape =>
  (v) =>
    values.includes(v);
const nullable =
  (shape: Shape): Shape =>
  (v) =>
    v === null || shape(v);
const optional =
  (shape: Shape): Shape =>
  (v) =>
    v === undefined || shape(v);
const list =
  (shape: Shape, max = 500): Shape =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(shape);
const record =
  (shape: Shape, max = 64): Shape =>
  (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length <= max && Object.entries(v).every(([k, x]) => k.length <= 64 && shape(x));
/** An object with at least these members, each of its shape (members not named are ignored, never read). */
const object =
  (members: Readonly<Record<string, Shape>>): Shape =>
  (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.entries(members).every(([k, shape]) => shape((v as Record<string, unknown>)[k]));
const either =
  (...shapes: readonly Shape[]): Shape =>
  (v) =>
    shapes.some((shape) => shape(v));

const code = (): Shape => text(64);
const iso = (): Shape => text(40);
const decimal = (): Shape => text(40, /^-?\d{1,30}(\.\d{1,8})?$/);
const key = (): Shape => text(66, INVOICE_KEY_PATTERN);
const hex32 = (): Shape => text(66, /^0x[0-9a-fA-F]{64}$/);
const rail = (): Shape => oneOf("PAYPAL", "USDC", "PYUSD");
const situation = (): Shape => oneOf("S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9");
const locale = (): Shape => oneOf("en", "fr", "mg");

const problemShape = (): Shape => object({ code: code(), status: num, rule: optional(code()), retryAfter: optional(num) });

export const healthShape = (): Shape =>
  object({
    status: oneOf("ok", "degraded", "down"),
    service: oneOf("paylink-api"),
    version: text(40),
    contract: num,
    time: iso(),
    paypalEnvironment: oneOf("sandbox"),
    rows: list(object({ id: code(), state: oneOf("ok", "degraded", "down", "not-configured", "unknown"), code: text(120), checkedAt: nullable(iso()), values: optional(record(num)) }), 32),
  });

export const railsShape = (): Shape =>
  object({ status: oneOf("open", "pending", "paid", "closed", "none"), amount: nullable(decimal()), currency: nullable(oneOf("USD")), url: nullable(text(2000)), checkedAt: nullable(iso()) });

const sessionShape = (): Shape => object({ token: text(512), payee: text(42, /^0x[0-9a-fA-F]{40}$/), expiresAt: iso() });

const draftShape = (): Shape =>
  either(
    object({
      outcome: oneOf("draft"),
      draft: object({
        amountBase: nullable(text(31, /^(0|[1-9]\d{0,30})$/)),
        amountText: nullable(text(200)),
        currency: nullable(oneOf("USD")),
        description: text(1000),
        clientName: nullable(text(200)),
        clientEmail: nullable(text(254)),
        dueDate: nullable(text(10, /^\d{4}-\d{2}-\d{2}$/)),
        clientLanguage: nullable(locale()),
      }),
      clarifications: list(code(), 16),
      confidence: oneOf("high", "medium", "low"),
      model: text(120),
    }),
    object({ outcome: oneOf("unavailable"), reason: code() }),
  );

export const twinShape = (): Shape =>
  object({
    key: key(),
    paypalId: text(64),
    number: text(64),
    status: code(),
    statusClass: code(),
    recipientViewUrl: nullable(text(2000)),
    amount: decimal(),
    currency: oneOf("USD"),
    situation: situation(),
    checkedAt: iso(),
  });

const proposalShape = (): Shape =>
  object({
    id: text(128),
    kind: code(),
    key: key(),
    invoiceNumber: text(64),
    amount: decimal(),
    rail: nullable(rail()),
    situation: situation(),
    exact: list(object({ label: code(), value: text(400) }), 16),
    reasonCode: code(),
    origin: oneOf("reconciler", "assistant"),
    message: nullable(object({ text: text(2000), language: locale(), grounded: bool })),
    args: record(text(400)),
    hash: hex32(),
    token: text(512),
    expiresAt: iso(),
    state: oneOf("open", "approving", "done", "stale", "rejected", "expired"),
    createdAt: iso(),
  });

const deskMembers = (): Readonly<Record<string, Shape>> => ({
  proposals: list(proposalShape(), 200),
  autoRecords: list(object({ id: text(128), key: key(), invoiceNumber: text(64), paymentId: text(64), rail: rail(), txHash: hex32(), recordedAt: iso(), undoUntil: iso(), undone: bool }), 200),
  alerts: list(object({ key: key(), invoiceNumber: nullable(text(64)), situation: oneOf("S0", "S4"), code: code(), raisedAt: iso() }), 200),
  checkedAt: nullable(iso()),
  assistant: object({ available: bool, reason: nullable(oneOf("disabled", "resting", "error")) }),
});

export const deskShape = (): Shape => object(deskMembers());
const sweepShape = (): Shape => object({ ...deskMembers(), sweep: object({ checked: num, remaining: num }) });

const approveShape = (): Shape =>
  either(
    object({ state: oneOf("done"), proposalId: text(128) }),
    object({ state: oneOf("signature-required"), proposalId: text(128), cancel: object({ key: key(), deadline: text(20, /^\d{1,20}$/) }) }),
  );

const rejectShape = (): Shape => object({ state: oneOf("rejected"), proposalId: text(128) });
const undoShape = (): Shape => object({ state: oneOf("undone"), key: key(), paymentId: text(64) });

export const checkShape = (): Shape =>
  object({
    verdict: oneOf("RECEIVED", "NOT_RECEIVED", "PARTLY_RECEIVED", "UNAVAILABLE"),
    sources: object({ paypal: oneOf("checked", "unavailable"), chain: oneOf("checked", "unavailable") }),
    matches: list(object({ key: key(), invoiceNumber: text(64), amount: decimal(), paidOn: list(rail(), 3) }), 50),
    links: list(object({ host: text(255), allowed: bool }), 50),
    checkedAt: iso(),
  });

// ------------------------------------------------------------------------------------------- transport

function route(id: ApiRouteId): (typeof API_ROUTES)[number] {
  const spec = API_ROUTES.find((r) => r.id === id);
  if (spec === undefined) {
    throw new Error(`no route ${id}`);
  }
  return spec;
}

function isProblemCode(value: string): value is ApiProblemCode {
  return Object.hasOwn(API_PROBLEMS, value);
}

/** The path of a route with its parameters filled in (each one checked, then percent-encoded). */
export function routePath(id: ApiRouteId, params: Readonly<Record<string, string>> = {}): string {
  return route(id).path.replace(/:([a-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === "" || value.length > 128) {
      throw new Error(`missing route parameter ${name}`);
    }
    return encodeURIComponent(value);
  });
}

export interface ApiCall {
  readonly route: ApiRouteId;
  readonly params?: Readonly<Record<string, string>>;
  readonly token?: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface PaypalApi {
  /** The API's base URL, without a trailing slash. */
  readonly url: string;
  /** One call; resolves with the JSON body and status of a 2xx answer, rejects with an `ApiError` otherwise. */
  call(request: ApiCall): Promise<{ readonly status: number; readonly body: unknown }>;
}

/** `value` once it has `shape`; an answer of another shape is the API's failure, never read further. */
function checked(shape: Shape, value: unknown, status: number): unknown {
  if (!shape(value)) {
    throw new ApiError(status, "invalid-response");
  }
  return value;
}

/** The client for the API at `url` (`fetcher` is replaceable in tests). */
export function paypalApi(url: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): PaypalApi {
  const base = url.replace(/\/+$/, "");
  return {
    url: base,
    async call(request) {
      const spec = route(request.route);
      const headers: Record<string, string> = { accept: "application/json" };
      if (request.token !== undefined) {
        headers[SESSION_HEADER] = `Bearer ${request.token}`;
      }
      if (request.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      let response: Response;
      try {
        response = await fetcher(`${base}${routePath(request.route, request.params)}`, {
          method: spec.method,
          headers,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
          signal: AbortSignal.timeout(request.timeoutMs ?? READ_TIMEOUT_MS),
        });
      } catch (error) {
        throw new ApiError(0, error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network");
      }
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        return { status: response.status, body };
      }
      if (problemShape()(body)) {
        const problem = body as { readonly code: string; readonly rule?: string; readonly retryAfter?: number };
        if (isProblemCode(problem.code)) {
          throw new ApiError(response.status, problem.code, problem.rule ?? null, problem.retryAfter ?? null);
        }
      }
      throw new ApiError(response.status, response.status === 501 ? "not-implemented" : response.status >= 500 ? "internal" : "invalid-response");
    },
  };
}

// ------------------------------------------------------------------------------------------- routes

export async function getHealth(api: PaypalApi): Promise<HealthResponse> {
  const { status, body } = await api.call({ route: "health" });
  return checked(healthShape(), body, status) as HealthResponse;
}

export async function getRails(api: PaypalApi, invoiceKey: InvoiceKey): Promise<RailsResponse> {
  const { status, body } = await api.call({ route: "rails.get", params: { key: invoiceKey } });
  return checked(railsShape(), body, status) as RailsResponse;
}

export async function postSession(api: PaypalApi, request: SessionRequest): Promise<SessionResponse> {
  const { status, body } = await api.call({ route: "session.create", body: request });
  return checked(sessionShape(), body, status) as SessionResponse;
}

export async function postDraft(api: PaypalApi, token: string, request: DraftRequest): Promise<DraftResponse> {
  const { status, body } = await api.call({ route: "ai.draft", token, body: request, timeoutMs: WRITE_TIMEOUT_MS });
  return checked(draftShape(), body, status) as DraftResponse;
}

/** `POST /v1/twin`: 201 when this request made the twin, 200 when it existed already. */
export async function postTwin(api: PaypalApi, token: string, request: TwinCreateRequest): Promise<{ readonly twin: TwinView; readonly created: boolean }> {
  const { status, body } = await api.call({ route: "twin.create", token, body: request, timeoutMs: WRITE_TIMEOUT_MS });
  return { twin: checked(twinShape(), body, status) as TwinView, created: status === 201 };
}

export async function getTwin(api: PaypalApi, token: string, invoiceKey: InvoiceKey): Promise<TwinView> {
  const { status, body } = await api.call({ route: "twin.get", token, params: { key: invoiceKey } });
  return checked(twinShape(), body, status) as TwinView;
}

export async function getDesk(api: PaypalApi, token: string): Promise<DeskResponse> {
  const { status, body } = await api.call({ route: "desk.get", token });
  return checked(deskShape(), body, status) as DeskResponse;
}

export async function postSweep(api: PaypalApi, token: string): Promise<DeskSweepResponse> {
  const { status, body } = await api.call({ route: "desk.sweep", token, timeoutMs: WRITE_TIMEOUT_MS });
  return checked(sweepShape(), body, status) as DeskSweepResponse;
}

export async function postApprove(api: PaypalApi, token: string, id: string, request: ApproveRequest): Promise<ApproveResponse> {
  const { status, body } = await api.call({ route: "desk.approve", token, params: { id }, body: request, timeoutMs: WRITE_TIMEOUT_MS });
  return checked(approveShape(), body, status) as ApproveResponse;
}

export async function postReject(api: PaypalApi, token: string, id: string): Promise<RejectResponse> {
  const { status, body } = await api.call({ route: "desk.reject", token, params: { id }, body: {} });
  return checked(rejectShape(), body, status) as RejectResponse;
}

export async function postUndo(api: PaypalApi, token: string, id: string): Promise<UndoResponse> {
  const { status, body } = await api.call({ route: "desk.undo", token, params: { id }, body: {}, timeoutMs: WRITE_TIMEOUT_MS });
  return checked(undoShape(), body, status) as UndoResponse;
}

export async function postCheck(api: PaypalApi, token: string, request: CheckRequest): Promise<CheckResponse> {
  const { status, body } = await api.call({ route: "check", token, body: request, timeoutMs: WRITE_TIMEOUT_MS });
  return checked(checkShape(), body, status) as CheckResponse;
}
