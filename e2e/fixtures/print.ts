// SPDX-License-Identifier: MIT
/**
 * Printing as the browser does it (PAYLINK-V2-SPEC §3.6: receipts on an 80 mm roll and A6, the receive card on A6).
 * The page's print key fills #print-area and calls `window.print()`; here `print()` is replaced by a no-op so the area
 * stays filled, and Chromium renders the print media to PDF with the page size the stylesheet asks for
 * (`preferCSSPageSize`). The size is read back from the PDF's first MediaBox, in millimetres, and the text from the
 * PDF itself (`pdfText`): what is on paper, not what the DOM holds.
 */
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { Locator, Page } from "@playwright/test";

const MM_PER_POINT = 25.4 / 72;

interface PdfObject {
  readonly dict: string;
  readonly stream: Buffer | null;
}

/** The PDF's indirect objects, streams inflated (Chromium writes FlateDecode streams). */
function pdfObjects(bytes: Buffer): Map<number, PdfObject> {
  const text = bytes.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const header = /(\d+) 0 obj\b/g;
  for (let match = header.exec(text); match !== null; match = header.exec(text)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endobj", start);
    if (end === -1) {
      break;
    }
    const body = text.slice(start, end);
    const at = body.search(/stream\r?\n/);
    if (at === -1) {
      objects.set(Number(match[1]), { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, at);
    const dataStart = start + at + (body.slice(at).startsWith("stream\r\n") ? 8 : 7);
    const length = /\/Length (\d+)(?!\s+\d+\s+R)/.exec(dict);
    const raw = length === null ? bytes.subarray(dataStart, start + body.lastIndexOf("endstream")) : bytes.subarray(dataStart, dataStart + Number(length[1]));
    let stream: Buffer = Buffer.from(raw);
    if (dict.includes("/FlateDecode")) {
      try {
        stream = inflateSync(raw);
      } catch {
        stream = Buffer.alloc(0);
      }
    }
    objects.set(Number(match[1]), { dict, stream });
    header.lastIndex = end;
  }
  return objects;
}

const utf16 = (hex: string): string => {
  const units: number[] = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    units.push(Number.parseInt(hex.slice(i, i + 4), 16));
  }
  return String.fromCharCode(...units);
};

/** A ToUnicode CMap: glyph code (hex) to text. */
function toUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src = "", dst = ""] of (block[1] ?? "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(src.toUpperCase(), utf16(dst));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo = "", hi = "", rest = ""] of (block[1] ?? "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const first = Number.parseInt(lo, 16);
      const last = Number.parseInt(hi, 16);
      const width = lo.length;
      if (rest.startsWith("[")) {
        [...rest.matchAll(/<([0-9A-Fa-f]+)>/g)].forEach(([, dst = ""], i) => {
          map.set((first + i).toString(16).toUpperCase().padStart(width, "0"), utf16(dst));
        });
      } else {
        const base = Number.parseInt(rest.slice(1, -1), 16);
        for (let code = first; code <= last; code += 1) {
          map.set(code.toString(16).toUpperCase().padStart(width, "0"), String.fromCharCode(base + code - first));
        }
      }
    }
  }
  return map;
}

/**
 * The text a Chromium PDF shows, in content-stream order: every `Tj`/`TJ` string decoded through its font's ToUnicode
 * CMap, one space between strings. Enough to assert what reached the paper (no layout reconstruction).
 */
export function pdfText(bytes: Buffer): string {
  const objects = pdfObjects(bytes);
  const fonts = new Map<string, Map<string, string>>();
  for (const { dict } of objects.values()) {
    for (const [, inner = ""] of dict.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
      for (const [, name = "", id = ""] of inner.matchAll(/\/([\w.+-]+)\s+(\d+)\s+0\s+R/g)) {
        const font = objects.get(Number(id));
        const cmapId = font === undefined ? null : /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(font.dict)?.[1];
        const cmap = cmapId === undefined || cmapId === null ? undefined : objects.get(Number(cmapId))?.stream;
        if (cmap !== undefined && cmap !== null) {
          fonts.set(name, toUnicode(cmap.toString("latin1")));
        }
      }
    }
  }
  const out: string[] = [];
  for (const { stream } of objects.values()) {
    const content = stream?.toString("latin1") ?? "";
    if (!/\bTf\b/.test(content) || !/\bT[jJ]\b/.test(content)) {
      continue;
    }
    let map: Map<string, string> | undefined;
    for (const [, font, show] of content.matchAll(/\/([\w.+-]+)\s+[\d.]+\s+Tf|(\[(?:[^\]]*)\]\s*TJ|<[0-9A-Fa-f]*>\s*Tj)/g)) {
      if (font !== undefined) {
        map = fonts.get(font);
        continue;
      }
      const decoded = [...(show ?? "").matchAll(/<([0-9A-Fa-f]*)>/g)]
        .map(([, hex = ""]) => {
          const width = hex.length % 4 === 0 ? 4 : 2;
          let text = "";
          for (let i = 0; i + width <= hex.length; i += width) {
            text += map?.get(hex.slice(i, i + width).toUpperCase()) ?? "";
          }
          return text;
        })
        .join("");
      out.push(decoded);
    }
  }
  return out.join(" ");
}

/**
 * Presses `key`, prints the result to PDF and returns the first page's size in millimetres (rounded to 0.1 mm), the
 * page count and the text on the paper. `save` keeps the PDF (a test artefact to look at).
 */
export async function printedPageSize(page: Page, key: Locator, save?: string): Promise<{ readonly width: number; readonly height: number; readonly pages: number; readonly text: string }> {
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
  return { width: mm(box[3] ?? "0") - mm(box[1] ?? "0"), height: mm(box[4] ?? "0") - mm(box[2] ?? "0"), pages, text: pdfText(bytes) };
}
