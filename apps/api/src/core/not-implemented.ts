// SPDX-License-Identifier: MIT
/**
 * The scaffold's placeholder for work a workstream has not delivered yet: a call answers 501 `not-implemented` with
 * the area's name, so the route table, the entries and the health rows run end to end from day one, and a missing
 * implementation is visible instead of silent.
 *
 * Owner: foundation. Workstreams delete their uses as they implement; nothing else may depend on it.
 */
import { ProblemError } from "./problem.ts";

/** Throws the 501 problem of `area`. */
export function notImplemented(area: string): never {
  throw new ProblemError("not-implemented", `${area} is not implemented yet`);
}

/** An async method that rejects with the 501 problem of `area`. */
export function pendingMethod(area: string): () => Promise<never> {
  return () => Promise.reject(new ProblemError("not-implemented", `${area} is not implemented yet`));
}
