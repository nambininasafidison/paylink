// SPDX-License-Identifier: MIT
/**
 * Printing as the browser does it (PAYLINK-V2-SPEC §3.6: receipts on an 80 mm roll and A6, the receive card on A6).
 * The page's print key fills #print-area and calls `window.print()`; here `print()` is replaced by a no-op so the area
 * stays filled, and Chromium renders the print media to PDF with the page size the stylesheet asks for
 * (`preferCSSPageSize`). The size is read back from the PDF's first MediaBox, in millimetres.
 */
import { writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

const MM_PER_POINT = 25.4 / 72;

/**
 * Presses `key`, prints the result to PDF and returns the first page's size in millimetres (rounded to 0.1 mm) and the
 * page count. `save` keeps the PDF (a test artefact to look at).
 */
export async function printedPageSize(page: Page, key: Locator, save?: string): Promise<{ readonly width: number; readonly height: number; readonly pages: number }> {
  await page.evaluate(() => {
    window.print = () => undefined;
  });
  await key.click();
  await page.locator("#print-area > *").first().waitFor({ state: "attached" });
  const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  if (save !== undefined) {
    writeFileSync(save, bytes);
  }
  const pdf = bytes.toString("latin1");
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf);
  if (box === null) {
    throw new Error("no MediaBox in the printed PDF");
  }
  const mm = (points: string): number => Math.round(Number(points) * MM_PER_POINT * 10) / 10;
  const pages = (pdf.match(/\/Type\s*\/Page\b/g) ?? []).length;
  await page.evaluate(() => {
    document.getElementById("print-area")?.replaceChildren();
  });
  return { width: mm(box[3] ?? "0") - mm(box[1] ?? "0"), height: mm(box[4] ?? "0") - mm(box[2] ?? "0"), pages };
}
