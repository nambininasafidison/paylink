// SPDX-License-Identifier: MIT
/** Small, dependency-free readers for the design package's CSS (comments stripped, custom properties per block). */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PACKAGE = resolve(import.meta.dirname, "..");
export const REPO = resolve(PACKAGE, "../..");

export function read(path: string): string {
  return readFileSync(join(PACKAGE, path), "utf8");
}

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every `--name: value` declaration of the first block whose selector text matches `selector`, in order. */
export function customProperties(css: string, selector: RegExp): Map<string, string> {
  const text = stripComments(css);
  const match = selector.exec(text);
  if (match === null) {
    throw new Error(`no block matches ${String(selector)}`);
  }
  const open = text.indexOf("{", match.index + match[0].length - 1);
  let depth = 0;
  let end = open;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") {
      depth += 1;
    } else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = text.slice(open + 1, end);
  const properties = new Map<string, string>();
  for (const declaration of body.split(";")) {
    const at = declaration.indexOf(":");
    const name = declaration.slice(0, at).trim();
    if (name.startsWith("--")) {
      properties.set(name, declaration.slice(at + 1).trim());
    }
  }
  return properties;
}
