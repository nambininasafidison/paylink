// SPDX-License-Identifier: MIT
/**
 * Which browser origins may call the relayer (CORS). Fixed in code, not configuration: the production app at
 * https://paylink-mg.pages.dev and its Cloudflare Pages preview deployments, `https://<label>.paylink-mg.pages.dev`
 * (a branch alias or a commit hash: exactly one DNS label). Nothing else, so a look-alike site cannot drive the
 * relayer from a visitor's browser.
 *
 * CORS is a browser policy, not access control: scripts and servers send no `Origin` and are served like any
 * client. What protects the relayer from them is the pipeline behind it (schema, SDK checks, admission ledger,
 * simulation, rate limits and the daily gas budget). A request that does carry an `Origin` outside the policy is
 * refused outright (403), preflight included, instead of being processed and hidden from the page.
 */

/** The v2 origin (fixed on 2026-10-07: Cloudflare Pages project "paylink-mg", passkey rpId paylink-mg.pages.dev; ADR 0005). */
export const PRODUCTION_ORIGIN = "https://paylink-mg.pages.dev";

/** One DNS label (RFC 1035 letters, digits and inner hyphens, at most 63 characters) under the production host. */
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.paylink-mg\.pages\.dev$/u;

export interface OriginPolicy {
  /** True when a browser page served from `origin` may call the relayer. */
  allows(origin: string): boolean;
  /** For logs and the health document. */
  readonly description: string;
}

/**
 * The production policy, optionally widened with exact extra origins (the Node adapter's local web server for
 * e2e). Extra origins must be bare `http://127.0.0.1:<port>` / `http://localhost:<port>` or https origins; a
 * wildcard or a path is refused.
 */
export function originPolicy(extraOrigins: readonly string[] = []): OriginPolicy {
  for (const origin of extraOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`not an origin: ${origin}`);
    }
    const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (url.origin !== origin || (url.protocol !== "https:" && !local)) {
      throw new Error(`extra origins must be bare https origins or local http origins: ${origin}`);
    }
  }
  const extra = new Set(extraOrigins);
  return {
    allows: (origin) => origin === PRODUCTION_ORIGIN || PREVIEW_ORIGIN.test(origin) || extra.has(origin),
    description: [PRODUCTION_ORIGIN, "https://<preview>.paylink-mg.pages.dev", ...extra].join(", "),
  };
}
