// SPDX-License-Identifier: MIT
/**
 * Layout probes for the reflow and text-expansion checks (PAYLINK-V2-SPEC §3.9 "visual tests cover text expansion in FR
 * and MG", §3.10 "reflow at 320 px", WCAG 2.2 SC 1.4.10, 2.4.11 and 2.5.8), run in the page:
 *
 * - `overlappingTargets`: footer links and labels (and any other selector given) whose boxes intersect. Two links
 *   drawn on the same spot are unreadable, their targets overlap, and a focused one is covered by the other.
 * - `brokenWords`: words split across two lines inside the word. Only runs of letters are words here (hex, addresses
 *   and URLs, which are meant to break, contain digits or sit in the excluded containers), and a break at a hyphen of a
 *   compound ("Toe-|draharaha") is a break between two words.
 * - `truncatedText`: the app's own copy cut by an ellipsis.
 * - `horizontalOverflow`: how far the document scrolls sideways.
 * - `focusRingContrast`, `selectedMarkContrast`: non-text contrast of a focus ring and of a selected-state mark.
 */
import type { Locator, Page } from "@playwright/test";

/** Containers whose text is meant to break anywhere (hex groups, URLs, inputs) or is not shown. */
const BREAKABLE = ".addr, .hex, code, .printed-url, .share, input, textarea, .details dd, .sr-only, script, style, noscript";

export async function overlappingTargets(page: Page, selector = ".foot .foot-label, .foot a"): Promise<string[]> {
  return await page.evaluate((sel) => {
    const boxes = [...document.querySelectorAll<HTMLElement>(sel)]
      .map((el) => ({ name: el.textContent.trim(), rect: el.getBoundingClientRect() }))
      .filter((b) => b.rect.width > 0 && b.rect.height > 0);
    const found: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (a === undefined || b === undefined) {
          continue;
        }
        const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (w > 0.5 && h > 0.5) {
          found.push(`"${a.name}" × "${b.name}" ${w.toFixed(0)}x${h.toFixed(0)}`);
        }
      }
    }
    return found;
  }, selector);
}

export async function brokenWords(page: Page): Promise<string[]> {
  return await page.evaluate((breakable) => {
    const found = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const word = /\p{L}{2,}/gu;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent ?? "";
      if (parent === null || text.trim() === "" || parent.closest(breakable) !== null || parent.closest("[hidden], dialog:not([open])") !== null) {
        continue;
      }
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none" || parent.getClientRects().length === 0) {
        continue;
      }
      for (const match of text.matchAll(word)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
        if (tops.size > 1) {
          const cls = (parent.getAttribute("class") ?? "").split(" ")[0] ?? "";
          const where = cls === "" ? parent.tagName.toLowerCase() : `${parent.tagName.toLowerCase()}.${cls}`;
          found.add(`${match[0]} (${where})`);
        }
      }
    }
    return [...found];
  }, BREAKABLE);
}

/**
 * Text cut by an ellipsis (information lost). The plate's network name gives way by design before the engraved model
 * does, and wallet names come from the wallet itself; neither is the app's own copy.
 */
export async function truncatedText(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const found: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (el.closest(".plate, .wallet-key, .sr-only, [hidden]") !== null) {
        continue;
      }
      const style = getComputedStyle(el);
      if (style.textOverflow === "ellipsis" && style.overflowX !== "visible" && el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 1) {
        found.push(`${el.textContent.trim().slice(0, 40)} (${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").split(" ")[0] ?? ""})`);
      }
    }
    return found;
  });
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Sets the interface language the app reads at start (prefs `paylink.locale`); takes effect on the next load. */
export async function setLocale(page: Page, locale: "en" | "fr" | "mg"): Promise<void> {
  await page.evaluate((value) => {
    localStorage.setItem("paylink.locale", value);
  }, locale);
}

/**
 * Contrast (WCAG 2.2 SC 1.4.11) between the focus ring `locator` shows when reached from the keyboard and the surface
 * it is drawn on (the first opaque background from the element up).
 */
export async function focusRingContrast(locator: Locator): Promise<number> {
  await locator.page().keyboard.press("Shift");
  await locator.focus();
  return await locator.evaluate((el) => {
    if (!el.matches(":focus-visible")) {
      throw new Error("the element is focused without a visible focus ring");
    }
    const rgb = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const opaque = (c: string): boolean => (rgb(c)[3] ?? 1) > 0.5;
    let surface = "rgb(255, 255, 255)";
    for (let node: Element | null = el.parentElement; node !== null; node = node.parentElement) {
      const c = getComputedStyle(node).backgroundColor;
      if (opaque(c)) {
        surface = c;
        break;
      }
    }
    const lum = (c: string): number => {
      const [r = 0, g = 0, b = 0] = rgb(c).slice(0, 3).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(getComputedStyle(el).outlineColor), lum(surface)].sort((a, b) => b - a);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  });
}

/** Contrast between the selected-state mark of `locator` (its ::after bar) and the key it sits on. */
export async function selectedMarkContrast(locator: Locator): Promise<number> {
  return await locator.evaluate((el) => {
    const rgb = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = (c: string): number => {
      const [r = 0, g = 0, b = 0] = rgb(c).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const mark = getComputedStyle(el, "::after");
    if (mark.content === "none" || mark.content === "normal" || Number.parseFloat(mark.height) < 2) {
      return 0;
    }
    const [hi, lo] = [lum(mark.backgroundColor), lum(getComputedStyle(el).backgroundColor)].sort((a, b) => b - a);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  });
}
