// SPDX-License-Identifier: MIT
/**
 * The desk (docs/paypal/SPEC.md §10, §13, §14.2 F5): the payee's proposals, auto-records and alerts; "Check my invoices";
 * and the executor's approval round trip. Every route is a session route: the app has already checked the bearer token
 * and passes the session's payee, whose store alone is read or written.
 *
 * | Route | Does |
 * |---|---|
 * | GET /v1/desk | `deskView`: open and recent proposals with a fresh approval token each, auto-records, alerts |
 * | POST /v1/desk/sweep | `sweep`: reconcile the open twins (≤ 20), then the desk assistant once, in the body's `locale` |
 * | POST /v1/desk/:id/approve | `approveProposal`: hash and token, single use, fresh read, fence, effect |
 * | POST /v1/desk/:id/reject | `rejectProposal` |
 * | POST /v1/desk/:id/undo | `undoRecord`: P7 within 24 hours of an automatic record (`id` = `r_<payment id>`) |
 *
 * The assistant is wired here (`createDeskHandlers(deskAgent)`): it reads through its tools and proposes through the
 * fence only; with the provider switched off or resting, the sweep says so and the reconciler's proposals stand (U6).
 *
 * Routes: desk.get, desk.sweep, desk.approve, desk.reject, desk.undo. Owner: reconciler workstream.
 */
import type { Address } from "@paylink/api-contract";
import * as z from "zod";
import { deskAgent } from "../ai/desk/agent.ts";
import { clientSource, json, parseBody, readJson, readOptionalJson } from "../core/http.ts";
import { ProblemError } from "../core/problem.ts";
import { assistantState, deskView, sweep } from "../reconciler/desk.ts";
import type { DeskAgent } from "../reconciler/desk.ts";
import { approveProposal, rejectProposal, undoRecord } from "../reconciler/executor.ts";
import type { HandlerArgs, RouteHandlers } from "./types.ts";
import { DEFAULT_BODY_LIMIT } from "./types.ts";

/** `POST /v1/desk/sweep`'s body: the payee's interface language; an empty body is the same as `{}`. */
export const SweepRequestSchema = z.strictObject({ locale: z.enum(["en", "fr", "mg"]).optional() });

export const ApproveRequestSchema = z.strictObject({
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/u, "a 32-byte hash"),
  token: z.string().min(1).max(512),
});

/** The session's payee (the app sets it on every session route). */
function payeeOf(args: HandlerArgs): Address {
  if (args.payee === null) {
    throw new ProblemError("unauthorized", "send Authorization: Bearer <session token>");
  }
  return args.payee;
}

const idOf = (args: HandlerArgs): string => args.c.req.param("id") ?? "";

/** The desk's handlers, with the desk assistant to run on a sweep (the AI workstream's `DeskAgent`), if any. */
export function createDeskHandlers(agent: DeskAgent | null = null): RouteHandlers {
  return {
    "desk.get": async (args) => json(args.c, await deskView(args.services, payeeOf(args), args.now, assistantState(args.services, agent))),
    "desk.sweep": async (args) => {
      const payee = payeeOf(args);
      const body = parseBody(SweepRequestSchema, await readOptionalJson(args.c, DEFAULT_BODY_LIMIT));
      return json(args.c, await sweep(args.services, payee, args.now, agent, { source: clientSource(args.c), ...(body.locale === undefined ? {} : { locale: body.locale }) }));
    },
    "desk.approve": async (args) => {
      const body = parseBody(ApproveRequestSchema, await readJson(args.c, DEFAULT_BODY_LIMIT));
      return json(args.c, await approveProposal(args.services, payeeOf(args), idOf(args), body, args.now));
    },
    "desk.reject": async (args) => json(args.c, await rejectProposal(args.services, payeeOf(args), idOf(args), args.now)),
    "desk.undo": async (args) => json(args.c, await undoRecord(args.services, payeeOf(args), idOf(args), args.now)),
  };
}

/** The deployed desk: "Check my invoices" runs the AI workstream's desk assistant (A2) once after the sweep. */
export const deskHandlers: RouteHandlers = createDeskHandlers(deskAgent);
