// SPDX-License-Identifier: MIT
/**
 * WCAG 2.2 AA through axe-core (PAYLINK-V2-SPEC §3.10 "axe reports 0 violations on every route, in light and dark"),
 * shared by every spec, on the page as a person reads it: after the entrance animations have played.
 *
 * A component that enters with a fade (the issued card's `rise`, the receipt's `print`, the verdict's `lcd`, a toast)
 * spends its first few hundred milliseconds at a partial opacity, and axe computes text contrast from the opacity it
 * finds. Run inside that window, axe reports contrast failures that no reader ever sees once the animation has ended,
 * and the gate went red at random. `settleAnimations` waits for every finite animation and transition of an element to
 * finish first. Infinite ones (a breathing lamp, a blinking LED) never finish and are left alone; animations of
 * pseudo-elements (the LED dots, the check box tick) carry no text and are left alone too.
 *
 * axe is injected over the DevTools protocol, because the pages' CSP forbids inline scripts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { REPO } from "./server.ts";

const AXE_SOURCE = readFileSync(join(REPO, "e2e/node_modules/axe-core/axe.min.js"), "utf8");
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Waits until no finite animation or transition of an element is running (new ones started meanwhile included), or
 * `timeoutMs` has passed. Returns the number of animations it waited for.
 */
export async function settleAnimations(page: Page, timeoutMs = 5_000): Promise<number> {
  return await page.evaluate(async (timeout) => {
    const deadline = performance.now() + timeout;
    let waited = 0;
    const running = (): Animation[] =>
      document.getAnimations().filter((animation) => {
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect) || effect.pseudoElement !== null || animation.playState === "finished") {
          return false;
        }
        const end = effect.getComputedTiming().endTime;
        return typeof end === "number" && Number.isFinite(end);
      });
    for (let pending = running(); pending.length > 0 && performance.now() < deadline; pending = running()) {
      waited += pending.length;
      const left = Math.max(0, deadline - performance.now());
      await Promise.race([
        Promise.all(pending.map(async (animation) => await animation.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, left)),
      ]);
    }
    return waited;
  }, timeoutMs);
}

/** axe-core's violations without waiting for animations: only for the fixture's own regression test. */
export async function axeNow(page: Page): Promise<string[]> {
  await page.evaluate(AXE_SOURCE);
  return await page.evaluate(async (tags) => {
    const run = (window as unknown as { axe: { run: (ctx: Document, o: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run;
    const result = await run(document, { runOnly: { type: "tag", values: tags } });
    return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  }, WCAG_22_AA);
}

/** WCAG 2.2 AA violations of the page as it reads once its entrance animations have finished ("id: targets"). */
export async function axe(page: Page): Promise<string[]> {
  await settleAnimations(page);
  return await axeNow(page);
}
