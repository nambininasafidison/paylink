// SPDX-License-Identifier: MIT
/**
 * Request schemas (PAYLINK-V2-SPEC §3.7 pipeline step 1): the structural gate every body passes before anything
 * else runs. They transcribe the `$defs` of docs/spec/paylink-invoice-v2.schema.json (JSON Schema 2020-12, invoice
 * spec §11) one for one, so a body the normative schema rejects never reaches the SDK, an RPC call or the Durable
 * Object; test/unit/schemas.test.ts holds the two in step through `z.toJSONSchema`.
 *
 * Structure only, as in the normative schema: EIP-55 checksums, the uint128/uint256 upper bounds and the invoice
 * shape rules are applied next by the SDK parsers (`parseRelayPayRequest`, `parseCancelAuthorizationJson`), then by
 * `checkRelayPayRequest` / `checkRelayCancelRequest` against the registry and the chain.
 *
 * The onboarding body (`POST /v1/{chainId}/onboard`) is the relayer's own: `{ chainId, address }`.
 */
import { z } from "zod";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** keccak256(""): an empty memo is 32 zero bytes, never this (invoice spec §3.1). */
const EMPTY_STRING_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
export const Bytes32Schema = z.string().regex(/^0x[0-9a-f]{64}$/u);
export const SignatureSchema = z.string().regex(/^0x([0-9a-f]{2}){1,512}$/u);
export const ChainIdSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
export const Uint32Schema = z.int().min(0).max(4_294_967_295);
export const Uint53SecondsSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export const Uint128StringSchema = z.string().regex(/^(0|[1-9][0-9]{0,38})$/u);
export const Uint256StringSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/u);

export const InvoiceSchema = z.strictObject({
  payee: AddressSchema.refine((value) => value !== ZERO_ADDRESS, { message: "must not be the zero address" }),
  token: AddressSchema,
  amount: Uint128StringSchema,
  validAfter: Uint53SecondsSchema,
  validUntil: Uint53SecondsSchema,
  maxPayments: Uint32Schema,
  salt: Bytes32Schema,
  memoHash: Bytes32Schema.refine((value) => value !== EMPTY_STRING_HASH, { message: 'must not be keccak256(""): an empty memo is 32 zero bytes' }),
});

export const PaymentAuthorizationSchema = z.strictObject({
  payer: AddressSchema,
  amount: Uint128StringSchema,
  payerRef: Bytes32Schema,
  validAfter: Uint256StringSchema,
  validBefore: Uint256StringSchema,
  payerSalt: Bytes32Schema,
  v: z.literal([27, 28]),
  r: Bytes32Schema,
  s: Bytes32Schema,
});

/** Body of `POST /v1/{chainId}/pay` (schema `RelayPayRequest`). */
export const RelayPayRequestSchema = z.strictObject({
  chainId: ChainIdSchema,
  invoice: InvoiceSchema,
  payeeSig: SignatureSchema,
  authorization: PaymentAuthorizationSchema,
});

/** Body of `POST /v1/{chainId}/cancel` (schema `CancelAuthorization`). */
export const CancelAuthorizationSchema = z.strictObject({
  chainId: ChainIdSchema,
  invoice: InvoiceSchema,
  deadline: Uint256StringSchema,
  payeeSig: SignatureSchema,
});

/** Body of `POST /v1/{chainId}/onboard`: the address to fund from the chain's testnet faucet. */
export const OnboardRequestSchema = z.strictObject({
  chainId: ChainIdSchema,
  address: AddressSchema.refine((value) => value !== ZERO_ADDRESS, { message: "must not be the zero address" }),
});

export type RelayPayRequestBody = z.infer<typeof RelayPayRequestSchema>;
export type CancelAuthorizationBody = z.infer<typeof CancelAuthorizationSchema>;
export type OnboardRequestBody = z.infer<typeof OnboardRequestSchema>;

/** The relayed operations and their body schemas. */
export const OPERATIONS = {
  pay: RelayPayRequestSchema,
  cancel: CancelAuthorizationSchema,
  onboard: OnboardRequestSchema,
} as const;

export type Operation = keyof typeof OPERATIONS;

export function isOperation(value: string): value is Operation {
  return Object.hasOwn(OPERATIONS, value);
}

/** At most this many issues are reported back, so that an oversized body cannot amplify the response. */
export const MAX_REPORTED_ISSUES = 8;

/** zod issues as `{ path, message }` with JSON paths (`$.invoice.payee`), the first `MAX_REPORTED_ISSUES` only. */
export function describeIssues(error: z.ZodError): { readonly path: string; readonly message: string }[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: ["$", ...issue.path.map((segment) => (typeof segment === "number" ? `[${String(segment)}]` : String(segment)))].join(".").replace(/\.\[/gu, "["),
    message: issue.message,
  }));
}
