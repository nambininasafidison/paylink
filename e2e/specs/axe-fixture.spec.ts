// SPDX-License-Identifier: MIT
/**
 * The accessibility gate reads a page as a person does (fixtures/axe.ts): after its entrance animations. Regression
 * test for a gate that went red at random: axe ran while the issued card was still fading in (`rise`, 350 ms) and
 * reported contrast failures that the finished card does not have.
 */
import { expect, test } from "@playwright/test";
import { axe, axeNow, settleAnimations } from "../fixtures/axe.ts";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fade-in</title><style>
  body { margin: 0; background: #fff; color: #1e1c1a; font: 16px/1.5 sans-serif; }
  .issued { animation: rise 1.6s ease both; }
  @keyframes rise { from { opacity: .15; } to { opacity: 1; } }
  .lamp { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ffb000; animation: breathe 1s ease-in-out infinite; }
  .lamp-label::before { content: ""; display: inline-block; width: 8px; height: 8px; background: #22c866; animation: breathe 1s infinite; }
  @keyframes breathe { 50% { opacity: .35; } }
</style></head><body><main><h1>Card</h1><p class="issued">Issued: the card is ready to share.</p>
<p><span class="lamp" aria-hidden="true"></span> <span class="lamp-label">Waiting</span></p></main></body></html>`;

test("axe waits for entrance animations, and is not held up by the breathing lamps", async ({ page }) => {
  await page.setContent(PAGE);
  const rise = page.locator(".issued");
  // Mid-fade, the text really is faint: axe run at that moment reports a contrast failure no reader sees for long.
  await rise.evaluate((el) => {
    const [animation] = el.getAnimations();
    if (animation === undefined) {
      throw new Error("the fade-in did not start");
    }
    animation.pause();
    animation.currentTime = 100;
  });
  expect(await axeNow(page)).toEqual([expect.stringMatching(/^color-contrast: \.issued$/)]);

  // The gate's helper waits for the fade to end (infinite lamps and pseudo-element animations are not waited for).
  await rise.evaluate((el) => {
    for (const animation of el.getAnimations()) {
      animation.play();
    }
  });
  const started = Date.now();
  expect(await axe(page)).toEqual([]);
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(await rise.evaluate((el) => el.getAnimations().map((a) => a.playState))).toEqual(["finished"]);
  // Nothing left to wait for: the infinite lamps keep breathing and settle returns at once.
  expect(await settleAnimations(page, 2_000)).toBe(0);
});
