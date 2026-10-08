// SPDX-License-Identifier: MIT
/**
 * The one piece of emphasis translations may carry: `*words*` becomes `<strong>` (v1's ledes stress one phrase each).
 * Everything else stays text. The completeness test checks that every language has the same, even number of `*`.
 */
import { h } from "./h.ts";

export function rich(message: string): (string | HTMLElement)[] {
  return message.split("*").map((part, i) => (i % 2 === 1 ? h("strong", null, part) : part));
}
