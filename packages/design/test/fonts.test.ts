// SPDX-License-Identifier: MIT
/** The design package self-hosts the same font files as v1, with their OFL texts next to them (NOTICE.md). */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE, read, REPO, stripComments } from "./css.ts";

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("fonts", () => {
  it("ships exactly v1's font files and licence texts, byte for byte", () => {
    const v1 = readdirSync(join(REPO, "web/fonts")).sort();
    const ours = readdirSync(join(PACKAGE, "fonts")).sort();
    expect(ours).toEqual(v1);
    expect(ours).toEqual(expect.arrayContaining(["OFL-Archivo.txt", "OFL-MartianMono.txt"]));
    for (const file of ours) {
      expect(sha256(join(PACKAGE, "fonts", file)), file).toBe(sha256(join(REPO, "web/fonts", file)));
    }
  });

  it("declares one face per file, with font-display swap", () => {
    const css = stripComments(read("src/fonts.css"));
    for (const file of ["archivo-var-latin.woff2", "martian-mono-400-latin.woff2", "martian-mono-600-latin.woff2"]) {
      expect(css).toContain(`url("../fonts/${file}") format("woff2")`);
    }
    expect(css.match(/font-display: swap/g)).toHaveLength(3);
  });
});
