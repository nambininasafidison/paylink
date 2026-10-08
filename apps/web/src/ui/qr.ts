// SPDX-License-Identifier: MIT
/**
 * QR codes drawn with `createElementNS` (ADR 0006): the module matrix from qrcode-generator (the MIT library v1
 * vendored as web/qrcode.js), rendered as one SVG path. No markup string is ever produced or parsed.
 */
import qrcode from "qrcode-generator";
import { h, svg } from "./h.ts";

/** Error correction: M as in v1 for short links, L once a link is long enough to make the code dense. */
export function correctionFor(text: string): "L" | "M" {
  return text.length > 300 ? "L" : "M";
}

/** The dark modules of the QR code of `text`, as a square boolean matrix. */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(0, correctionFor(text));
  code.addData(text, "Byte");
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_unused, col) => code.isDark(row, col)));
}

/** SVG path data: one 1×1 square per dark module, merged along rows. */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  matrix.forEach((cells, row) => {
    let col = 0;
    while (col < cells.length) {
      if (cells[col] === true) {
        let run = 1;
        while (cells[col + run] === true) {
          run += 1;
        }
        parts.push(`M${String(col)} ${String(row)}h${String(run)}v1h-${String(run)}z`);
        col += run;
      } else {
        col += 1;
      }
    }
  });
  return parts.join("");
}

/** The QR code as an image for assistive technology, labelled with what it encodes. */
export function qrSvg(text: string, label: string): HTMLDivElement {
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const quiet = 2;
  return h(
    "div",
    { class: "qr", attrs: { role: "img", "aria-label": label } },
    svg(
      "svg",
      { viewBox: `${String(-quiet)} ${String(-quiet)} ${String(size + 2 * quiet)} ${String(size + 2 * quiet)}`, "aria-hidden": "true", focusable: "false" },
      svg("rect", { x: String(-quiet), y: String(-quiet), width: String(size + 2 * quiet), height: String(size + 2 * quiet), fill: "#fff" }),
      svg("path", { class: "qr-dark", d: qrPath(matrix) }),
    ),
  );
}
