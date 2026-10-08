// SPDX-License-Identifier: MIT
/**
 * The zod schemas are the normative JSON Schema (docs/spec/paylink-invoice-v2.schema.json, invoice spec §11) in
 * another notation. `z.toJSONSchema` of each must equal the spec's definition with its `$ref`s resolved, keyword
 * for keyword, after two normalisations a schema translator cannot avoid: the spec's `not: { const }` exclusions
 * (zod refinements, which have no JSON Schema form) are compared behaviourally instead, and zod's `enum` is the
 * spec's `enum` (zod adds `type: "number"` beside it, which is dropped before comparing).
 */
import { readFileSync } from "node:fs";
import { toRelayPayRequest } from "@paylink/sdk";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { CancelAuthorizationSchema, InvoiceSchema, OnboardRequestSchema, PaymentAuthorizationSchema, RelayPayRequestSchema } from "../../src/core/schemas.ts";

type JsonSchema = Record<string, unknown>;
const spec = JSON.parse(readFileSync(new URL("../../../../docs/spec/paylink-invoice-v2.schema.json", import.meta.url), "utf8")) as { $defs: Record<string, JsonSchema> };

/** The spec definition with `$ref`s inlined and annotations (`description`, `$comment`, `not`) removed. */
function resolveSpec(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(resolveSpec);
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const record = node as JsonSchema;
  if (typeof record["$ref"] === "string") {
    const name = record["$ref"].replace("#/$defs/", "");
    const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "$ref"));
    return resolveSpec({ ...spec.$defs[name], ...rest });
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !["description", "$comment", "not", "title", "examples"].includes(key))
      .map(([key, value]) => [key, resolveSpec(value)]),
  );
}

/** zod's export without the `$schema` header, and without the `type` zod adds next to an `enum` of numbers. */
function exportZod(schema: z.ZodType): unknown {
  const strip = (node: unknown): unknown => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return node;
    }
    const record = node as JsonSchema;
    const enumOfNumbers = Array.isArray(record["enum"]) && record["enum"].every((value) => typeof value === "number") && record["type"] === "number";
    return Object.fromEntries(Object.entries(record).filter(([key]) => !(enumOfNumbers && key === "type")).map(([key, value]) => [key, strip(value)]));
  };
  const exported = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "throw" }) as JsonSchema;
  return strip(Object.fromEntries(Object.entries(exported).filter(([key]) => key !== "$schema")));
}

describe("zod schemas equal the normative JSON Schema", () => {
  it.each([
    ["Invoice", InvoiceSchema],
    ["PaymentAuthorization", PaymentAuthorizationSchema],
    ["RelayPayRequest", RelayPayRequestSchema],
    ["CancelAuthorization", CancelAuthorizationSchema],
  ] as const)("%s", (name, schema) => {
    expect(exportZod(schema)).toEqual(resolveSpec(spec.$defs[name]));
  });

  it("keeps the spec's exclusions: payee is not the zero address, memoHash is not keccak256('')", () => {
    expect(spec.$defs["Invoice"]?.["properties"]).toMatchObject({
      payee: { not: { const: "0x0000000000000000000000000000000000000000" } },
      memoHash: { not: { const: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" } },
    });
    const example = (spec as unknown as { examples: { invoice: Record<string, unknown> }[] }).examples[0]?.invoice;
    expect(InvoiceSchema.safeParse(example).success).toBe(true);
    expect(InvoiceSchema.safeParse({ ...example, payee: "0x0000000000000000000000000000000000000000" }).success).toBe(false);
    expect(InvoiceSchema.safeParse({ ...example, memoHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" }).success).toBe(false);
  });

  it("accepts what the SDK serialises for the relayer", () => {
    const example = (spec as unknown as { examples: { invoice: Record<string, unknown>; payeeSig: string }[] }).examples[0];
    const invoice = InvoiceSchema.parse(example?.invoice);
    const request = toRelayPayRequest(
      {
        chainId: 10143,
        invoice: { ...invoice, payee: invoice.payee as `0x${string}`, token: invoice.token as `0x${string}`, amount: BigInt(invoice.amount), validAfter: BigInt(invoice.validAfter), validUntil: BigInt(invoice.validUntil), salt: invoice.salt as `0x${string}`, memoHash: invoice.memoHash as `0x${string}` },
        signature: (example?.payeeSig ?? "0x") as `0x${string}`,
      },
      { payer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", amount: 25_000_000n, payerRef: `0x${"00".repeat(32)}`, validAfter: 0n, validBefore: 1_791_159_000n, payerSalt: `0x${"11".repeat(32)}`, v: 27, r: `0x${"22".repeat(32)}`, s: `0x${"33".repeat(32)}` },
    );
    expect(RelayPayRequestSchema.safeParse(JSON.parse(JSON.stringify(request))).success).toBe(true);
  });

  it("onboarding takes exactly a chain id and an address", () => {
    expect(OnboardRequestSchema.safeParse({ chainId: 10143, address: "0x000000000000000000000000000000000000dEaD" }).success).toBe(true);
    expect(OnboardRequestSchema.safeParse({ chainId: 10143, address: "0x000000000000000000000000000000000000dEaD", amount: "1" }).success).toBe(false);
    expect(OnboardRequestSchema.safeParse({ chainId: 0, address: "0x000000000000000000000000000000000000dEaD" }).success).toBe(false);
  });
});
