// SPDX-License-Identifier: MIT
/**
 * The status mapping of docs/paypal/SPEC.md §7.4 against its sources: the 16 statuses are exactly the `enum` of
 * `invoice_status` in the vendored Invoicing v2 OpenAPI file (test/openapi/invoicing_v2.json,
 * paypal-rest-api-specifications at 90e8041), each has the class the §7.4 table gives it, and a status PayPal adds
 * later reads `unknown` (S0, hands off). The fake only ever answers statuses of that enum.
 */
import { PAYPAL_INVOICE_STATUSES, STATUS_CLASS, statusClassOf } from "@paylink/api-contract";
import { describe, expect, it } from "vitest";
import { loadSpec, SPEC_FILES } from "../openapi/contract.ts";

interface StatusSchema {
  readonly enum: readonly string[];
  readonly "x-enumDescriptions": readonly { readonly value: string }[];
}

const schema = (loadSpec(SPEC_FILES.invoicing) as unknown as { components: { schemas: { invoice_status: StatusSchema } } }).components.schemas.invoice_status;

/** SPEC §7.4, row by row. */
const TABLE: readonly (readonly [string, readonly string[]])[] = [
  ["open", ["SENT", "SHARED", "UNPAID"]],
  ["open-not-sent", ["SCHEDULED"]],
  ["not-sent", ["DRAFT"]],
  ["paid", ["PAID"]],
  ["paid-outside", ["MARKED_AS_PAID", "PAID_EXTERNAL"]],
  ["in-flight", ["PAYMENT_PENDING", "PARTIALLY_PAID"]],
  ["cancelled", ["CANCELLED", "AUTO_CANCELLED"]],
  ["refunded", ["REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED", "REFUNDED_EXTERNAL"]],
];

describe("PayPal invoice statuses (SPEC §7.4)", () => {
  it("are exactly the vendored invoice_status enum, in its order", () => {
    expect([...PAYPAL_INVOICE_STATUSES]).toEqual(schema.enum);
    expect(schema["x-enumDescriptions"].map((d) => d.value)).toEqual(schema.enum);
  });

  it("each has the class of the §7.4 table, and the table names every status once", () => {
    const named = TABLE.flatMap(([, statuses]) => statuses);
    expect([...named].sort()).toEqual([...PAYPAL_INVOICE_STATUSES].sort());
    for (const [cls, statuses] of TABLE) {
      for (const status of statuses) {
        expect([status, statusClassOf(status)]).toEqual([status, cls]);
      }
    }
    expect(Object.keys(STATUS_CLASS).sort()).toEqual([...PAYPAL_INVOICE_STATUSES].sort());
  });

  it("reads anything else as unknown", () => {
    for (const status of ["", "VOIDED", "paid", "SHARED ", "__proto__", "toString"]) {
      expect(statusClassOf(status)).toBe("unknown");
    }
  });
});
