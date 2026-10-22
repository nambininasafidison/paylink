// SPDX-License-Identifier: MIT
/**
 * The desk's toolkit-named tools follow the PayPal Agent Toolkit's tool contract (docs/paypal/SPEC.md §7.6 Plan B,
 * decision D-AI): names and actions as in the toolkit's `tools.ts`, and every parameter a subset of the toolkit's own zod
 * schema with the same constraints, checked by evaluating the vendored `parameters.ts` of `@paypal/agent-toolkit` 1.11.0
 * (commit a3aa963, test/vendor/) with zod 4's `zod/v3` API. Every payload PayLink's tools accept, the toolkit's schema
 * accepts too. The evaluated copy is written under node_modules/.cache (git-ignored), never next to the sources.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DESK_TOOLS, TOOL_ARGUMENTS } from "../../src/ai/desk/tools.ts";

const API = join(import.meta.dirname, "../..");
const VENDOR = join(API, "test/vendor/paypal-agent-toolkit-1.11.0");
const read = (name: string): string => readFileSync(join(VENDOR, name), "utf8");

interface ZodV3 {
  readonly shape?: Readonly<Record<string, ZodV3>>;
  readonly _def: { readonly innerType?: ZodV3; readonly typeName: string };
  safeParse(value: unknown): { readonly success: boolean };
}
type Factory = (context: Readonly<Record<string, unknown>>) => ZodV3;

let toolkit: Readonly<Record<string, Factory>>;

beforeAll(async () => {
  const dir = join(API, "node_modules/.cache/paylink-toolkit-parity");
  mkdirSync(dir, { recursive: true });
  const js = (ts: string): string => stripTypeScriptTypes(ts, { mode: "strip" });
  writeFileSync(join(dir, "regex.mjs"), js(read("regex.ts.txt")));
  // `constants.ts` is not vendored: its subscription keys only name properties of subscription tools.
  writeFileSync(join(dir, "constants.mjs"), "export const subscriptionKeys = new Proxy({}, { get: (_, key) => String(key) });\n");
  const parameters = js(read("parameters.ts.txt"))
    .replace(/from\s+['"]zod['"]/u, 'from "zod/v3"')
    .replace(/from\s+["']\.\/regex["']/u, 'from "./regex.mjs"')
    .replace(/from\s+["']\.\/constants["']/u, 'from "./constants.mjs"');
  writeFileSync(join(dir, "parameters.mjs"), parameters);
  toolkit = (await import(pathToFileURL(join(dir, "parameters.mjs")).href)) as Readonly<Record<string, Factory>>;
});

/** The toolkit schema of each toolkit-named desk tool (the factory names of `tools.ts`). */
const FACTORY: Readonly<Record<string, string>> = { list_invoices: "listInvoicesParameters", get_invoice: "getInvoicParameters", search_invoicing: "searchInvoicingParameters" };
const ACTION: Readonly<Record<string, string>> = { list_invoices: "list", get_invoice: "get", search_invoicing: "search" };

const unwrap = (schema: ZodV3): ZodV3 => (schema._def.innerType === undefined ? schema : unwrap(schema._def.innerType));

describe("PayPal Agent Toolkit 1.11.0 parity", () => {
  it("the vendored sources are the recorded ones", () => {
    const sums = read("SOURCE.md");
    for (const name of ["tools.ts.txt", "parameters.ts.txt", "regex.ts.txt", "configuration.ts.txt", "LICENSE"]) {
      const digest = createHash("sha256").update(readFileSync(join(VENDOR, name))).digest("hex");
      expect(sums, name).toContain(`| \`${name}\` | \`${digest}\` |`);
    }
  });

  it("names, factories and actions are the toolkit's", () => {
    const tools = read("tools.ts.txt");
    for (const [name, factory] of Object.entries(FACTORY)) {
      const block = new RegExp(`method: '${name}',[\\s\\S]*?parameters: (\\w+)\\(context\\),[\\s\\S]*?actions: \\{\\s*invoices: \\{\\s*(\\w+): true`, "u").exec(tools);
      expect(block?.[1], name).toBe(factory);
      expect(block?.[2], name).toBe(ACTION[name]);
      expect(DESK_TOOLS.some((t) => t.name === name)).toBe(true);
    }
  });

  it("every parameter of a toolkit-named tool is one of the toolkit's, nested filters included", () => {
    for (const [name, factory] of Object.entries(FACTORY)) {
      const theirs = toolkit[factory]?.({});
      const ours = DESK_TOOLS.find((t) => t.name === name)?.parameters as { properties: Record<string, { properties?: Record<string, unknown> }> };
      expect(theirs?.shape, factory).toBeDefined();
      for (const [key, value] of Object.entries(ours.properties)) {
        const their = theirs?.shape?.[key];
        expect(their, `${name}.${key}`).toBeDefined();
        if (value.properties !== undefined && their !== undefined) {
          const nested = unwrap(their).shape ?? {};
          for (const inner of Object.keys(value.properties)) {
            expect(nested[inner], `${name}.${key}.${inner}`).toBeDefined();
          }
        }
      }
    }
  });

  it("whatever PayLink's tools accept, the toolkit's schemas accept; and they refuse what it refuses", () => {
    const accepted: readonly (readonly [keyof typeof FACTORY & keyof typeof TOOL_ARGUMENTS, unknown])[] = [
      ["list_invoices", {}],
      ["list_invoices", { page: 1, page_size: 100, total_required: true }],
      ["list_invoices", { page: 1000, page_size: 1 }],
      ["get_invoice", { invoice_id: "INV2-ABCD-1234-EFGH-5678" }],
      ["search_invoicing", { resource_type: "invoice" }],
      ["search_invoicing", { resource_type: "invoice", page: 2, page_size: 50, total_required: true, invoice_filters: { status: ["SENT", "SHARED", "UNPAID", "PAYMENT_PENDING", "PARTIALLY_PAID"], invoice_number: "PL-11155111-3fa9c0e17b2d", reference: `0x${"ab".repeat(32)}` } }],
    ];
    for (const [name, payload] of accepted) {
      expect(TOOL_ARGUMENTS[name].safeParse(payload).success, `ours: ${name} ${JSON.stringify(payload)}`).toBe(true);
      expect(toolkit[FACTORY[name] ?? ""]?.({}).safeParse(payload).success, `toolkit: ${name} ${JSON.stringify(payload)}`).toBe(true);
    }
    const refused: readonly (readonly [keyof typeof FACTORY & keyof typeof TOOL_ARGUMENTS, unknown])[] = [
      ["list_invoices", { page: 0 }],
      ["list_invoices", { page_size: 101 }],
      ["get_invoice", { invoice_id: "../../v1/oauth2/token" }],
      ["get_invoice", {}],
      ["search_invoicing", { resource_type: "invoice", invoice_filters: { status: ["SENT", "SHARED", "UNPAID", "PAID", "DRAFT", "CANCELLED"] } }],
      ["search_invoicing", { resource_type: "invoice", invoice_filters: { invoice_number: "X".repeat(26) } }],
    ];
    for (const [name, payload] of refused) {
      expect(TOOL_ARGUMENTS[name].safeParse(payload).success, `ours: ${name} ${JSON.stringify(payload)}`).toBe(false);
      expect(toolkit[FACTORY[name] ?? ""]?.({}).safeParse(payload).success, `toolkit: ${name} ${JSON.stringify(payload)}`).toBe(false);
    }
    // Stricter than the toolkit on purpose: recurring series and recipient filters are not offered (no data the desk needs).
    expect(TOOL_ARGUMENTS.search_invoicing.safeParse({ resource_type: "recurring_series" }).success).toBe(false);
    expect(TOOL_ARGUMENTS.search_invoicing.safeParse({ resource_type: "invoice", invoice_filters: { recipient_email: "a@b.co" } }).success).toBe(false);
    expect(toolkit["searchInvoicingParameters"]?.({}).safeParse({ resource_type: "invoice", invoice_filters: { recipient_email: "a@b.co" } }).success).toBe(true);
  });
});
