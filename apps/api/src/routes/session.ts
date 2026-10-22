// SPDX-License-Identifier: MIT
/**
 * POST /v1/session: verify the signed `PayLinkSession` (src/session/factory.ts, docs/paypal/SPEC.md §12.2) and answer a
 * session token. The body is checked by its zod schema before any signature work; the request's source (its client IP)
 * goes with it for the per-source daily limit.
 *
 * Routes: session.create. Owner: reconciler workstream.
 */
import type { SessionRequest } from "@paylink/api-contract";
import * as z from "zod";
import { clientSource, json, parseBody, readJson } from "../core/http.ts";
import type { RouteHandlers } from "./types.ts";
import { DEFAULT_BODY_LIMIT } from "./types.ts";

const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/u, "a decimal number of seconds");

export const SessionRequestSchema = z.strictObject({
  chainId: z.number().int().positive(),
  session: z.strictObject({
    payee: z.string().regex(/^0x[0-9a-fA-F]{40}$/u, "an address"),
    origin: z.string().min(1).max(200),
    issuedAt: decimal,
    expiresAt: decimal,
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/u, "32 bytes of hex"),
  }),
  // 65 bytes for ECDSA; an ERC-1271 account's signature may be longer (invoice spec: at most 512 bytes).
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){1,512}$/u, "hex bytes"),
});

export const sessionHandlers: RouteHandlers = {
  "session.create": async ({ c, services, now }) => {
    const body = parseBody(SessionRequestSchema, await readJson(c, DEFAULT_BODY_LIMIT)) as SessionRequest;
    return json(c, await services.sessions.open(body, now, { source: clientSource(c) }), 201);
  },
};
