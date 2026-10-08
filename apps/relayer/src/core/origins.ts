// SPDX-License-Identifier: MIT
/**
 * Which browser origins may call the relayer (CORS). Fixed in code, not configuration: the production app at
 * https://paylink-mg.pages.dev and nothing else, so a look-alike site cannot drive the relayer from a visitor's
 * browser.
 *
 * Deployment hosts `https://<hash>.paylink-mg.pages.dev` and branch aliases are refused (narrowed 2026-10-08, ADR
 * 0005): previews are meant to be disabled, and every deployment Cloudflare Pages keeps, production ones included,
 * stays reachable at its own hash host. A build withdrawn after an incident (docs/security/incident-response.md PB-2)
 * must not keep a working relayer behind it.
 *
 * CORS is a browser policy, not access control: scripts and servers send no `Origin` and are served like any
 * client. What protects the relayer from them is the pipeline behind it (schema, SDK checks, admission ledger,
 * simulation, rate limits and the daily gas budget). A request that does carry an `Origin` outside the policy is
 * refused outright (403), preflight included, instead of being processed and hidden from the page.
 */

/** The v2 origin (fixed on 2026-10-07: Cloudflare Pages project "paylink-mg", passkey rpId paylink-mg.pages.dev; ADR 0005). */
export const PRODUCTION_ORIGIN = "https://paylink-mg.pages.dev";

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
    allows: (origin) => origin === PRODUCTION_ORIGIN || extra.has(origin),
    description: [PRODUCTION_ORIGIN, ...extra].join(", "),
  };
}
