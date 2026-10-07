// SPDX-License-Identifier: MIT
/**
 * Lifecycle status of recorded deployments (invoice spec §4.2). Hand-maintained: a recorded deployment is
 * `active` unless it is listed here. Set `deprecated` when a newer deployment replaces it (existing links stay
 * payable, with a warning) and `revoked` during an incident (payments are disabled; see
 * docs/security/incident-response.md).
 */
import type { DeploymentStatus } from "./types.ts";

export const DEPLOYMENT_STATUS: Readonly<Partial<Record<number, DeploymentStatus>>> = {};
