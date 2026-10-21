// SPDX-License-Identifier: MIT
/**
 * `GET /v1/health` (docs/paypal/SPEC.md §13, §14.2 F8): public rows for the Status page. Public data only: no token, no
 * key, no request body. Owner: foundation (each workstream fills its own row).
 */
import type { IsoInstant } from "./common.ts";

export const HEALTH_ROWS = ["paypal", "webhook", "assistant", "chain", "store"] as const;
export type HealthRowId = (typeof HEALTH_ROWS)[number];

/** `not-configured`: the secret or binding the row needs is absent; `unknown`: nothing has been checked yet. */
export type HealthState = "ok" | "degraded" | "down" | "not-configured" | "unknown";

export interface HealthRow {
  readonly id: HealthRowId;
  readonly state: HealthState;
  /** A fixed code the Status page renders with i18n text (`token-cached`, `last-get-ok`, `budget-left`, ...). */
  readonly code: string;
  readonly checkedAt: IsoInstant | null;
  /** Row-specific numbers: seconds since the last verified webhook, assistant budget left today in neurons, ... */
  readonly values?: Readonly<Record<string, number>>;
}

export interface HealthResponse {
  readonly status: "ok" | "degraded" | "down";
  readonly service: "paylink-api";
  readonly version: string;
  readonly contract: number;
  readonly time: IsoInstant;
  /** `sandbox` always: the PayPal edition never talks to live PayPal (docs/paypal/SPEC.md §2.2). */
  readonly paypalEnvironment: "sandbox";
  readonly rows: readonly HealthRow[];
}
