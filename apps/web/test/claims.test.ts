// @vitest-environment node
// SPDX-License-Identifier: MIT
/**
 * What the site says about itself must hold. PayLinkV2 has had our own review (protocol/audit/README.md), not a
 * third-party audit, so no text the site serves may call it audited: every word starting with "audit" in a shipped
 * string must be negated in its own clause ("not audited", "non audité", "pas encore audité").
 *
 * Shipped text, outside the frozen v1 app under /arc/: the core and feature catalogues in every language, the HTML
 * entries, the PWA manifest (vite.config.ts), the files in public/, the app's TypeScript with its comments removed
 * (they do not reach the bundle), and the deploy kit served at /deploy/ and /v2/deploy/ except its vendored viem.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(import.meta.dirname, "..");
const REPO = join(APP, "../..");

/** A word starting with "audit" in any of our languages (audit, audited, auditor, audité, auditée). */
const AUDIT_WORD = /audit\p{L}*/giu;
/** The clause before the word holds a negation: not, no, never, non, pas, aucun, sans; Malagasy tsy. */
const NEGATED = /\b(?:not|no|never|non|pas|aucun|aucune|sans|tsy)\b[^.;:!?()]*$/iu;

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return walk(path, keep);
    }
    return keep(path) ? [path] : [];
  });
}

const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** Every shipped text file, with the text a visitor can see or a bundle can carry. */
function shippedTexts(): { readonly file: string; readonly text: string }[] {
  const read = (path: string): string => readFileSync(path, "utf8");
  const locales = walk(join(REPO, "packages/i18n/src/locales"), (p) => p.endsWith(".json") && !p.endsWith(".review.json"));
  const entries = [join(APP, "index.html"), join(APP, "404.html"), ...["ledger", "pay", "r", "send", "status", "till"].map((page) => join(APP, page, "index.html"))];
  const publicFiles = walk(join(APP, "public"), (p) => /\.(json|txt|html|webmanifest)$/.test(p) || p.endsWith("_headers"));
  const kit = walk(join(REPO, "web/v2/deploy"), (p) => !p.includes(join("deploy", "vendor")) && /\.(html|js|json|css)$/.test(p));
  const sources = walk(join(APP, "src"), (p) => p.endsWith(".ts"));
  return [
    ...[...locales, ...entries, ...publicFiles, ...kit].map((file) => ({ file, text: read(file) })),
    ...[...sources, join(APP, "vite.config.ts")].map((file) => ({ file, text: withoutComments(read(file)) })),
  ].map(({ file, text }) => ({ file: relative(REPO, file), text }));
}

/** Each use of an "audit" word that is not negated in its clause, with the text before it. */
function auditClaims(text: string): string[] {
  return [...text.matchAll(AUDIT_WORD)].filter((match) => !NEGATED.test(text.slice(Math.max(0, match.index - 60), match.index))).map((match) => text.slice(Math.max(0, match.index - 40), match.index + match[0].length));
}

describe("claims the site makes about itself", () => {
  it("tells an audit claim from a negated one", () => {
    expect(auditClaims("One audited bytecode.")).toHaveLength(1);
    expect(auditClaims("Un seul bytecode audité.")).toHaveLength(1);
    expect(auditClaims("publishes the audited release")).toHaveLength(1);
    // A negation in an earlier sentence does not count.
    expect(auditClaims("Not on mainnet. Audited by us.")).toHaveLength(1);
    expect(auditClaims("the PayLinkV2 2.0.0 release (self-reviewed, not audited)")).toEqual([]);
    expect(auditClaims("version non auditée ; pas encore audité")).toEqual([]);
    expect(auditClaims("One release bytecode.")).toEqual([]);
  });

  it("never calls the contract audited in any text the site serves", () => {
    const texts = shippedTexts();
    // The scan reaches every area it promises to cover.
    for (const area of ["packages/i18n/src/locales/en.json", "packages/i18n/src/locales/history.mg.json", "apps/web/pay/index.html", "apps/web/src/pages/status.ts", "web/v2/deploy/index.html", "web/v2/deploy/app.js"]) {
      expect(texts.map((t) => t.file)).toContain(area);
    }
    expect(texts.some((t) => t.file.includes("deploy/vendor/"))).toBe(false);
    const claims = texts.flatMap(({ file, text }) => auditClaims(text).map((claim) => `${file}: …${claim}`));
    expect(claims).toEqual([]);
  });
});
