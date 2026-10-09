// SPDX-License-Identifier: MIT
/**
 * The SDK's strict `Paid` decoder and topic, as the history reader (`read/activity.ts`) takes them. Pages import this
 * statically (the SDK is already in their first load) and hand it to the lazily loaded history code.
 */
import { decodePaidLog, PAID_TOPIC } from "@paylink/sdk";
import type { PaidLogReader } from "./activity.ts";

export const paidLogReader: PaidLogReader = { topic: PAID_TOPIC, decode: decodePaidLog };
