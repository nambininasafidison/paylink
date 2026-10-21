// SPDX-License-Identifier: MIT
/**
 * The vendored PayPal OpenAPI files (test/openapi/, provenance in SOURCE.md) are the ones the provenance names, and the
 * client's operation table and types agree with them: each operation P2–P11, P13 and P14 exists with its method, P1 is
 * the files' `tokenUrl`, and the request bodies of the specification validate against the request schemas with ajv.
 * The full L0 suite (every request the client sends and every answer it parses, against the fake) is
 * test/openapi/contract.test.ts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { PAYPAL_OPERATIONS } from "../src/paypal/client.ts";
import type { CreateInvoiceRequest, Notification, PaymentDetail, SearchInvoicesRequest } from "../src/paypal/types.ts";

interface Spec {
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: { readonly schemas: Record<string, unknown> };
  readonly servers: readonly { readonly url: string }[];
  readonly info: { readonly version: string };
}

const file = (name: string): string => readFileSync(new URL(`openapi/${name}`, import.meta.url), "utf8");
const invoicing = JSON.parse(file("invoicing_v2.json")) as Spec;
const webhooks = JSON.parse(file("notifications_webhooks_v1.json")) as Spec;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** ajv over one file's components, OpenAPI 3.0 style (nullable, readOnly members allowed in requests: PayLink sends none). */
function validator(spec: Spec, schema: string): (value: unknown) => readonly string[] {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  (addFormatsModule as unknown as (a: Ajv) => void)(ajv);
  ajv.addSchema({ components: spec.components }, "spec.json");
  const validate = ajv.compile({ $ref: `spec.json#/components/schemas/${schema}` });
  return (value) => (validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`));
}

describe("vendored OpenAPI files (paypal-rest-api-specifications@90e8041)", () => {
  it("are the files SOURCE.md names, byte for byte", () => {
    const source = file("SOURCE.md");
    for (const name of ["invoicing_v2.json", "notifications_webhooks_v1.json", "LICENSE"]) {
      expect(source, name).toContain(sha256(file(name)));
    }
    expect(invoicing.info.version).toBe("2.6");
    expect(webhooks.info.version).toBe("1.11");
    expect(invoicing.servers.map((s) => s.url)).toEqual(["https://api-m.sandbox.paypal.com", "https://api-m.paypal.com"]);
  });

  it("define every operation P2–P11, P13 and P14 with the method the client uses, and P1 as their token URL", () => {
    for (const spec of [invoicing, webhooks]) {
      expect(JSON.stringify(spec)).toContain('"tokenUrl":"/v1/oauth2/token"');
    }
    for (const [id, op] of Object.entries(PAYPAL_OPERATIONS)) {
      if (id === "P1") {
        continue;
      }
      const spec = op.path.startsWith("/v1/notifications/") ? webhooks : invoicing;
      expect(spec.paths[op.path], `${id} ${op.path}`).toBeDefined();
      expect(spec.paths[op.path]?.[op.method.toLowerCase()], `${id} ${op.method}`).toBeDefined();
    }
  });
});

describe("request bodies validate against the request schemas", () => {
  it("P3: the twin of docs/paypal/SPEC.md §7.2", () => {
    const body: CreateInvoiceRequest = {
      detail: {
        currency_code: "USD",
        reference: `0x${"ab".repeat(32)}`,
        invoice_number: "PL-11155111-abababababab",
        note: "Prefer PayPal USD, no fee? https://paypal.paylink-mg.pages.dev/paypal/pay/#x",
        payment_term: { due_date: "2026-11-06" },
      },
      primary_recipients: [{ billing_info: { name: { given_name: "Sarah" } } }],
      items: [{ name: "Logo design", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }],
      configuration: { partial_payment: { allow_partial_payment: false }, allow_tip: false },
    };
    expect(validator(invoicing, "invoice")(body)).toEqual([]);
    expect(body.detail.invoice_number?.length).toBeLessThanOrEqual(25);
    expect(validator(invoicing, "invoice")({ ...body, detail: { ...body.detail, invoice_number: "X".repeat(26) } }).join()).toMatch(/invoice_number/u);
  });

  it("P4, P8, P9: notifications without subject or note (PayPal ignores them)", () => {
    const share: Notification = { send_to_recipient: false, send_to_invoicer: false };
    const remind: Notification = { send_to_recipient: true, send_to_invoicer: false };
    expect(validator(invoicing, "notification")(share)).toEqual([]);
    expect(validator(invoicing, "notification")(remind)).toEqual([]);
  });

  it("P2: search by reference; P6: an external payment with the echo note of §7.3", () => {
    const search: SearchInvoicesRequest = { reference: `0x${"ab".repeat(32)}` };
    expect(validator(invoicing, "search_data")(search)).toEqual([]);
    const record: PaymentDetail = {
      method: "OTHER",
      payment_date: "2026-10-21",
      amount: { currency_code: "USD", value: "120.00" },
      note: `PayLink · eip155:11155111 · tx 0x${"cd".repeat(32)} · key 0x${"ab".repeat(32)}`,
    };
    expect(validator(invoicing, "payment_detail")(record)).toEqual([]);
    expect(validator(invoicing, "payment_detail")({ amount: record.amount }).join()).toMatch(/method/u);
  });

  it("P10: verify-webhook-signature needs all seven members", () => {
    const body = {
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
      transmission_id: "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
      transmission_sig: "lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==",
      transmission_time: "2016-02-18T20:01:35Z",
      webhook_id: "1JE4291016473214C",
      webhook_event: { id: "8PT597110X687430LKGECATA", event_type: "INVOICING.INVOICE.PAID" },
    };
    const check = validator(webhooks, "verify_webhook_signature");
    expect(check(body)).toEqual([]);
    const missing: Record<string, unknown> = { ...body };
    delete missing["webhook_id"];
    expect(check(missing).join()).toMatch(/webhook_id/u);
  });
});
