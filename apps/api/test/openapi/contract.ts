// SPDX-License-Identifier: MIT
/**
 * L0 (docs/paypal/SPEC.md §15.2): validates a PayPal request or response against the operation's schema in the vendored
 * OpenAPI files (`paypal-rest-api-specifications@90e8041`, this folder), with ajv. `contractTransport` wraps any
 * transport (the PayPal fake's, in tests) and checks every request the client sends and every answer it parses.
 *
 * The files are read as they are; two of their own defects, and one answer of PayPal's sandbox that they do not list,
 * are corrected in memory before compiling, and only those:
 *
 * 1. `payment_reference.payment_id` writes `minLength: "1"` and `maxLength: "22"` as strings, which JSON Schema (and
 *    ajv) refuses: they are read as the numbers they mean.
 * 2. `verify_webhook_signature.transmission_sig` has the pattern `^(?!\d+$)\w+\S+`, which a base64 signature beginning
 *    with `+` or `/` (one in 32) would fail although it is what PayPal itself delivers in the `PAYPAL-TRANSMISSION-SIG`
 *    header: the pattern is not applied to that member.
 * 3. `invoices.remind-400` lists two issues; to a reminder for an invoice without a billing email the sandbox answered
 *    400 `INVALID_REQUEST` with a third, `CANNOT_REMIND_AS_BILLING_INFO_ABSENT` (the owner's capture of 2026-10-29,
 *    docs/research/paypal/capture-2026-10-29.md), which the PayPal fake now answers too: that issue is added to the
 *    list, and nothing else.
 *
 * OpenAPI 3.0 keywords JSON Schema does not know (`nullable`, `x-*`) and PayPal's own formats (`ppaas_*`) are ignored
 * (ajv `strict: false`); `readOnly` members are annotations, so a request carrying one passes here and is refused by the
 * fake instead (src/paypal/fake/app.ts). P1 (the token) is in neither file: its answer is checked with the client's own
 * parser (src/paypal/parse.ts), which follows the Agent Toolkit's documented response.
 *
 * Owner: PayPal spine workstream.
 */
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { PayPalOperationId } from "../../src/paypal/client.ts";
import { PAYPAL_OPERATIONS } from "../../src/paypal/client.ts";
import { operationOf } from "../../src/paypal/fake/index.ts";
import { parsePayPal } from "../../src/paypal/parse.ts";

interface Operation {
  readonly requestBody?: { readonly content?: Readonly<Record<string, { readonly schema?: unknown }>> };
  readonly responses: Readonly<Record<string, { readonly $ref?: string; readonly content?: Readonly<Record<string, { readonly schema?: unknown }>> }>>;
}

interface Spec {
  readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
  readonly components: { readonly schemas: Record<string, unknown>; readonly responses?: Readonly<Record<string, { readonly content?: Readonly<Record<string, { readonly schema?: unknown }>> }>> };
}

export const SPEC_FILES = { invoicing: "invoicing_v2.json", webhooks: "notifications_webhooks_v1.json" } as const;

export function loadSpec(name: (typeof SPEC_FILES)[keyof typeof SPEC_FILES]): Spec {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as Spec;
}

/** The issue PayPal's sandbox answered to a reminder without a billing email (correction 3 of the module comment). */
export const SANDBOX_REMIND_400_ISSUE = "CANNOT_REMIND_AS_BILLING_INFO_ABSENT";

/** The three in-memory corrections of the module comment. */
function corrected(spec: Spec): Spec {
  const copy = structuredClone(spec);
  const remind400 = (copy.components.schemas["invoices.remind-400"] as { properties?: { details?: { items?: { anyOf?: unknown[] } } } } | undefined)?.properties?.details?.items?.anyOf;
  if (remind400 !== undefined) {
    remind400.push({ title: SANDBOX_REMIND_400_ISSUE, properties: { issue: { type: "string", enum: [SANDBOX_REMIND_400_ISSUE] } } });
  }
  const reference = (copy.components.schemas["payment_reference"] as { properties?: { payment_id?: Record<string, unknown> } } | undefined)?.properties?.payment_id;
  if (reference !== undefined) {
    for (const bound of ["minLength", "maxLength"]) {
      if (typeof reference[bound] === "string") {
        reference[bound] = Number(reference[bound]);
      }
    }
  }
  const signature = (copy.components.schemas["verify_webhook_signature"] as { properties?: { transmission_sig?: Record<string, unknown> } } | undefined)?.properties?.transmission_sig;
  if (signature !== undefined) {
    delete signature["pattern"];
  }
  return copy;
}

/** Rewrites local `$ref`s (`#/components/...`) to the registered document. */
function anchored(schema: unknown, id: string): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => anchored(item, id));
  }
  if (typeof schema === "object" && schema !== null) {
    return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, k === "$ref" && typeof v === "string" && v.startsWith("#/") ? `${id}${v}` : anchored(v, id)]));
  }
  return schema;
}

export interface ContractValidator {
  /** Problems of a request body (empty when valid); `null` body for operations without one. */
  request(op: PayPalOperationId, body: string | null): readonly string[];
  /** Problems of a response (empty when valid). */
  response(op: PayPalOperationId, status: number, body: string | null): readonly string[];
}

export function contractValidator(): ContractValidator {
  const docs = { invoicing: corrected(loadSpec(SPEC_FILES.invoicing)), webhooks: corrected(loadSpec(SPEC_FILES.webhooks)) };
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  (addFormatsModule as unknown as (a: Ajv) => void)(ajv);
  // PayPal's own formats (`ppaas_*`) have no published definition: known to ajv, checked by their patterns only.
  for (const format of new Set(JSON.stringify(docs).match(/"format":"ppaas_[a-z0-9_]+"/gu) ?? [])) {
    ajv.addFormat(format.slice(10, -1), true);
  }
  for (const [name, spec] of Object.entries(docs)) {
    ajv.addSchema({ components: spec.components }, `${name}.json`);
  }
  const cache = new Map<string, ValidateFunction | null>();
  const compiled = (key: string, doc: keyof typeof docs, schema: unknown): ValidateFunction | null => {
    if (!cache.has(key)) {
      cache.set(key, schema === undefined ? null : ajv.compile(anchored(schema, `${doc}.json`) as object));
    }
    return cache.get(key) ?? null;
  };
  const locate = (op: PayPalOperationId): { readonly doc: keyof typeof docs; readonly operation: Operation } => {
    const { method, path } = PAYPAL_OPERATIONS[op];
    const doc = path.startsWith("/v1/notifications/") ? "webhooks" : "invoicing";
    const operation = docs[doc].paths[path]?.[method.toLowerCase()];
    if (operation === undefined) {
      throw new Error(`${op} ${method} ${path} is not in ${SPEC_FILES[doc]}`);
    }
    return { doc, operation };
  };
  const problems = (validate: ValidateFunction, text: string | null): readonly string[] => {
    let value: unknown;
    try {
      value = text === null ? undefined : JSON.parse(text);
    } catch {
      return ["the body is not JSON"];
    }
    return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  };
  return {
    request(op, body) {
      if (op === "P1") {
        return [];
      }
      const { doc, operation } = locate(op);
      const schema = operation.requestBody?.content?.["application/json"]?.schema;
      if (schema === undefined) {
        return body === null || body === "" ? [] : ["the operation takes no body"];
      }
      const validate = compiled(`${op} request`, doc, schema);
      return validate === null ? [] : problems(validate, body);
    },
    response(op, status, body) {
      if (op === "P1") {
        // In neither file: the toolkit's documented answer (src/paypal/types.ts), checked by the client's own parser.
        return status !== 200 || parsePayPal.token(body === null ? null : JSON.parse(body)) !== null ? [] : ["not the documented token answer"];
      }
      const { doc, operation } = locate(op);
      const declared = operation.responses[String(status)] ?? operation.responses["default"];
      if (declared === undefined) {
        return [`status ${String(status)} is not declared`];
      }
      const content = declared.$ref === undefined ? declared.content : docs[doc].components.responses?.[declared.$ref.split("/").at(-1) ?? ""]?.content;
      const schema = content?.["application/json"]?.schema;
      if (schema === undefined) {
        return body === null || body === "" ? [] : [`status ${String(status)} has no body`];
      }
      const validate = compiled(`${op} ${String(status)}`, doc, schema);
      return validate === null ? [] : problems(validate, body);
    },
  };
}

/** One request and its answer, as the contract transport saw them, with their problems. */
export interface CheckedExchange {
  readonly op: PayPalOperationId;
  readonly status: number;
  readonly requestProblems: readonly string[];
  readonly responseProblems: readonly string[];
}

/** Wraps `transport`: every exchange of a known operation is validated and recorded. */
export function contractTransport(transport: typeof fetch, validator: ContractValidator = contractValidator()): { readonly fetch: typeof fetch; readonly exchanges: CheckedExchange[] } {
  const exchanges: CheckedExchange[] = [];
  return {
    exchanges,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const op = operationOf(request.method, new URL(request.url).pathname);
      const body = request.method === "GET" || request.method === "DELETE" ? null : await request.clone().text();
      const response = await transport(request);
      if (op !== null) {
        const text = await response.clone().text();
        exchanges.push({ op, status: response.status, requestProblems: validator.request(op, body), responseProblems: validator.response(op, response.status, text === "" ? null : text) });
      }
      return response;
    },
  };
}
