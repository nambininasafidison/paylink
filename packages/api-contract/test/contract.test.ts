// SPDX-License-Identifier: MIT
/**
 * The contract's own invariants, and its PayPal facts checked against PayPal's OpenAPI file at 90e8041, vendored in
 * apps/api/test/openapi/ (so a typo in either place fails).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  API_PROBLEMS,
  API_ROUTES,
  ASSISTANT_UNAVAILABLE_REASONS,
  CHAIN_STATES,
  CLARIFICATION_CODES,
  HEALTH_ROWS,
  INVOICE_KEY_PATTERN,
  PAYPAL_EDITION_CHAIN_ID,
  PAYPAL_INVOICE_STATUSES,
  PAYPAL_STATUS_CLASSES,
  PROPOSAL_ACTOR,
  PROPOSAL_KINDS,
  RAILS,
  SESSION_MAX_SECONDS,
  SESSION_TYPES,
  SITUATIONS,
  STATUS_CLASS,
  statusClassOf,
} from "../src/index.ts";

const invoicing = JSON.parse(readFileSync(new URL("../../../apps/api/test/openapi/invoicing_v2.json", import.meta.url), "utf8")) as {
  info: { version: string };
  components: { schemas: Record<string, { enum?: string[] }> };
};

describe("route table (docs/paypal/SPEC.md §13 with the D-SCOPE cuts)", () => {
  it("lists each route once, under /v1/, with a unique id", () => {
    expect(new Set(API_ROUTES.map((r) => r.id)).size).toBe(API_ROUTES.length);
    expect(new Set(API_ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(API_ROUTES.length);
    for (const route of API_ROUTES) {
      expect(route.path).toMatch(/^\/v1\/[a-z/:]+$/u);
    }
  });

  it("is exactly the specification's table without the cut free-text desk question", () => {
    expect(API_ROUTES.map((r) => `${r.method} ${r.path} ${r.auth}`)).toEqual([
      "POST /v1/session signature",
      "POST /v1/ai/draft session",
      "POST /v1/twin session",
      "GET /v1/twin/:key session",
      "GET /v1/rails/:key public",
      "POST /v1/paypal/webhook paypal",
      "GET /v1/desk session",
      "POST /v1/desk/sweep session",
      "POST /v1/desk/:id/approve session",
      "POST /v1/desk/:id/reject session",
      "POST /v1/desk/:id/undo session",
      "POST /v1/check session",
      "GET /v1/health public",
    ]);
    expect(API_ROUTES.map((r): string => r.path)).not.toContain("/v1/desk/ask");
  });
});

describe("problems", () => {
  it("map every code to an HTTP error status and a title", () => {
    for (const [code, { status, title }] of Object.entries(API_PROBLEMS)) {
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
      expect(title.length, code).toBeGreaterThan(0);
    }
    expect(API_PROBLEMS["not-implemented"].status).toBe(501);
    expect(API_PROBLEMS.stale.status).toBe(409);
  });
});

describe("PayPal statuses (invoicing_v2.json @ 90e8041, Invoices 2.6)", () => {
  it("are exactly the 16 values of invoice_status, in the file's order", () => {
    expect(invoicing.info.version).toBe("2.6");
    expect([...PAYPAL_INVOICE_STATUSES]).toEqual(invoicing.components.schemas["invoice_status"]?.enum);
  });

  it("each have a class of §7.4, and anything else is unknown", () => {
    expect(Object.keys(STATUS_CLASS).sort()).toEqual([...PAYPAL_INVOICE_STATUSES].sort());
    for (const cls of Object.values(STATUS_CLASS)) {
      expect(PAYPAL_STATUS_CLASSES).toContain(cls);
    }
    expect(statusClassOf("SHARED")).toBe("open");
    expect(statusClassOf("PAID")).toBe("paid");
    expect(statusClassOf("MARKED_AS_PAID")).toBe("paid-outside");
    expect(statusClassOf("PARTIALLY_PAID")).toBe("in-flight");
    expect(statusClassOf("SOMETHING_NEW")).toBe("unknown");
    expect(statusClassOf("__proto__")).toBe("unknown");
  });
});

describe("enumerations", () => {
  it("have no duplicates", () => {
    for (const list of [PAYPAL_STATUS_CLASSES, RAILS, CHAIN_STATES, SITUATIONS, PROPOSAL_KINDS, CLARIFICATION_CODES, ASSISTANT_UNAVAILABLE_REASONS, HEALTH_ROWS]) {
      expect(new Set<string>(list).size).toBe(list.length);
    }
  });

  it("name an actor for every proposal kind, and only auto-record is automatic (D-07)", () => {
    expect(Object.keys(PROPOSAL_ACTOR).sort()).toEqual([...PROPOSAL_KINDS].sort());
    expect(Object.entries(PROPOSAL_ACTOR).filter(([, actor]) => actor === "automatic").map(([kind]) => kind)).toEqual(["record_external_payment"]);
    expect(PROPOSAL_ACTOR.cancel_paylink).toBe("tap-and-signature");
  });

  it("offer no money-moving kind (AI-2)", () => {
    for (const kind of PROPOSAL_KINDS) {
      expect(kind).not.toMatch(/refund|capture|pay_order|dispute/u);
    }
  });

  it("fix the PayPal edition to Ethereum Sepolia and sessions to at most 12 hours", () => {
    expect(PAYPAL_EDITION_CHAIN_ID).toBe(11155111);
    expect(SESSION_MAX_SECONDS).toBe(43_200);
    expect(SESSION_TYPES.PayLinkSession.map((f) => f.name)).toEqual(["payee", "origin", "issuedAt", "expiresAt", "nonce"]);
  });

  it("accept only lowercase 32-byte invoice keys", () => {
    expect(INVOICE_KEY_PATTERN.test(`0x${"ab".repeat(32)}`)).toBe(true);
    expect(INVOICE_KEY_PATTERN.test(`0x${"AB".repeat(32)}`)).toBe(false);
    expect(INVOICE_KEY_PATTERN.test(`0x${"ab".repeat(31)}`)).toBe(false);
  });
});
