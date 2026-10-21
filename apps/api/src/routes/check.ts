// SPDX-License-Identifier: MIT
/**
 * POST /v1/check: "Was I really paid?", the deterministic verdict from P5 and the chain (docs/paypal/SPEC.md §9.2, AI-6;
 * src/reconciler/check.ts). The pasted text is data: code extracts references, amounts and links from it, never a model,
 * and it is neither stored nor logged.
 *
 * Routes: check. Owner: reconciler workstream.
 */
import * as z from "zod";
import { json, parseBody, readJson } from "../core/http.ts";
import { ProblemError } from "../core/problem.ts";
import { CHECK_MAX_TEXT, checkMessage } from "../reconciler/check.ts";
import type { RouteHandlers } from "./types.ts";
import { BODY_LIMITS, DEFAULT_BODY_LIMIT } from "./types.ts";

export const CheckRequestSchema = z.strictObject({ text: z.string().min(1).max(CHECK_MAX_TEXT) });

export const checkHandlers: RouteHandlers = {
  check: async ({ c, services, payee, now }) => {
    if (payee === null) {
      throw new ProblemError("unauthorized", "send Authorization: Bearer <session token>");
    }
    const body = parseBody(CheckRequestSchema, await readJson(c, BODY_LIMITS.check ?? DEFAULT_BODY_LIMIT));
    return json(c, await checkMessage(services, payee, body.text, now));
  },
};
