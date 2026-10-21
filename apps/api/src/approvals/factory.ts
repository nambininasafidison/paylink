// SPDX-License-Identifier: MIT
/**
 * Builds the approval service (canonical proposal hash, HMAC tokens under `APPROVAL_HMAC_KEY`).
 *
 * Owner: reconciler workstream. Scaffold: every call answers 501 `not-implemented`, so nothing can be approved.
 */
import { pendingMethod } from "../core/not-implemented.ts";
import type { FactoryDeps } from "../core/runtime.ts";
import type { Approvals } from "./types.ts";

export function createApprovals(deps: FactoryDeps): Approvals {
  const pending = pendingMethod(`approvals (${deps.runtime.secrets.approvalHmacKey === undefined ? "no key" : "key set"})`);
  return { hash: pending, issue: pending, verify: pending };
}
