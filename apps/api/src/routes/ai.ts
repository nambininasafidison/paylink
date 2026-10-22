// SPDX-License-Identifier: MIT
/**
 * POST /v1/ai/draft: A1, a client message to an invoice draft (docs/paypal/SPEC.md §9.2), admitted by
 * src/ai/admission.ts: the payee's daily assistant quota, its request source's, the public or demo lane's, and the
 * neurons of each (src/ai/budget.ts keeps the daily ceiling).
 *
 * Every way the assistant cannot help answers 200 `{ outcome: "unavailable", reason }` and the web edition opens the
 * manual form with a notice (U6): `disabled` (no provider), `resting` (a quota or the day's neurons are used up),
 * `refused`, `timeout`, `invalid_output`, `error`. A malformed request is 400 `invalid-request`; no session is 401.
 *
 * Routes: ai.draft. Owner: AI workstream.
 */
import { DRAFT_MAX_TEXT } from "@paylink/api-contract";
import type { DraftResponse } from "@paylink/api-contract";
import * as z from "zod";
import { admitAssistant } from "../ai/admission.ts";
import type { AiProvider } from "../ai/types.ts";
import { draftInvoice } from "../ai/draft.ts";
import { clientSource, json, parseBody, readJson } from "../core/http.ts";
import { ProblemError } from "../core/problem.ts";
import type { RouteHandlers } from "./types.ts";
import { BODY_LIMITS } from "./types.ts";

export const DraftRequestSchema = z.strictObject({
  text: z.string().trim().min(1, "paste the client's message").max(DRAFT_MAX_TEXT),
  locale: z.enum(["en", "fr", "mg"]),
});

export const aiHandlers: RouteHandlers = {
  "ai.draft": async ({ c, services, payee, now }) => {
    if (payee === null) {
      throw new ProblemError("unauthorized", "send Authorization: Bearer <session token>");
    }
    const body = parseBody(DraftRequestSchema, await readJson(c, BODY_LIMITS["ai.draft"] ?? 16 * 1024));
    if (services.ai.kind === "disabled") {
      return json(c, { outcome: "unavailable", reason: "disabled" } satisfies DraftResponse);
    }
    let ai: AiProvider;
    try {
      ai = await admitAssistant(services, { payee, source: clientSource(c) }, now);
    } catch (error) {
      if (error instanceof ProblemError && error.problem.code === "quota-exhausted") {
        services.runtime.logger.log("info", "a1.resting", { rule: error.problem.rule });
        return json(c, { outcome: "unavailable", reason: "resting" } satisfies DraftResponse);
      }
      throw error;
    }
    return json(c, await draftInvoice({ ai, logger: services.runtime.logger, now }, body));
  },
};
