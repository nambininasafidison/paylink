// SPDX-License-Identifier: MIT
/**
 * A static server that behaves like Cloudflare Pages for the parts the site relies on (docs/runbooks/cloudflare-pages.md),
 * so the e2e suite runs the production build under its production headers:
 *
 * - routing: `/dir/` serves `dir/index.html`; `/dir` and `/dir/index.html` redirect to `/dir/`; an unknown path gets
 *   the nearest `404.html` walking up from it, with status 404 (workers-sdk asset-server `handler.ts`);
 * - `_headers`: every rule whose path pattern matches applies, in file order; within a rule, `! Name` detaches a header
 *   set by an earlier rule before the rule's own headers are set; a header set twice is joined with a comma
 *   (workers-sdk `parseHeaders.ts` and `attachHeaders`). Patterns support one `*` splat and `:placeholders`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const SITE = join(REPO, "apps/web/dist");
export const E2E_SITE = join(REPO, "apps/web/dist-e2e");

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
};

export interface HeaderRule {
  readonly pattern: RegExp;
  readonly path: string;
  readonly set: readonly (readonly [string, string])[];
  readonly unset: readonly string[];
}

/** Cloudflare Pages `_headers`. */
export function parsePagesHeaders(text: string): HeaderRule[] {
  const rules: { path: string; set: [string, string][]; unset: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("/") || line.startsWith("https://")) {
      rules.push({ path: line, set: [], unset: [] });
      continue;
    }
    const rule = rules.at(-1);
    if (rule === undefined) {
      throw new Error(`_headers: header before any path: ${line}`);
    }
    if (line.startsWith("! ")) {
      rule.unset.push(line.slice(2).trim().toLowerCase());
      continue;
    }
    const at = line.indexOf(":");
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    const existing = rule.set.find(([n]) => n === name);
    if (existing === undefined) {
      rule.set.push([name, value]);
    } else {
      existing[1] = `${existing[1]}, ${value}`;
    }
  }
  const escape = (s: string): string => s.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
  return rules.map((rule) => {
    const source = rule.path
      .split("*")
      .map((part) => escape(part).replace(/:([A-Za-z]\w*)/g, "(?<$1>[^/]+)"))
      .join("(?<splat>.*)");
    return { pattern: new RegExp(`^${source}$`), path: rule.path, set: rule.set, unset: rule.unset };
  });
}

/** The headers a request path gets, applying the rules in order as Cloudflare does. */
export function headersFor(rules: readonly HeaderRule[], pathname: string): Map<string, string> {
  const headers = new Map<string, string>();
  const setByRules = new Set<string>();
  for (const rule of rules) {
    if (!rule.pattern.test(pathname)) {
      continue;
    }
    for (const name of rule.unset) {
      headers.delete(name);
    }
    for (const [name, value] of rule.set) {
      const current = headers.get(name);
      headers.set(name, setByRules.has(name) && current !== undefined ? `${current}, ${value}` : value);
      setByRules.add(name);
    }
  }
  return headers;
}

export interface StaticServer {
  readonly origin: string;
  close(): Promise<void>;
}

export async function servePages(root: string = SITE): Promise<StaticServer> {
  const rules = parsePagesHeaders(readFileSync(join(root, "_headers"), "utf8"));
  const file = (rel: string): string | null => {
    const path = normalize(join(root, rel));
    if (!path.startsWith(root + sep) && path !== root) {
      return null;
    }
    return existsSync(path) && statSync(path).isFile() ? path : null;
  };
  const send = (response: ServerResponse, status: number, pathname: string, path: string | null, extra: Record<string, string> = {}): void => {
    for (const [name, value] of headersFor(rules, pathname)) {
      response.setHeader(name, value);
    }
    for (const [name, value] of Object.entries(extra)) {
      response.setHeader(name, value);
    }
    if (path === null) {
      response.writeHead(status).end();
      return;
    }
    response.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
    response.writeHead(status).end(readFileSync(path));
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = url.pathname;
    }
    if (pathname.endsWith("/")) {
      const index = file(`${pathname}index.html`);
      if (index !== null) {
        send(response, 200, url.pathname, index);
        return;
      }
    } else {
      const exact = file(pathname);
      if (exact !== null && !pathname.endsWith("/index.html")) {
        send(response, 200, url.pathname, exact);
        return;
      }
      if (pathname.endsWith("/index.html") || file(`${pathname}/index.html`) !== null) {
        const target = pathname.endsWith("/index.html") ? pathname.slice(0, -"index.html".length) : `${pathname}/`;
        send(response, 308, url.pathname, null, { location: `${target}${url.search}` });
        return;
      }
    }
    // The nearest 404.html, walking up from the requested path.
    let cwd = pathname;
    while (cwd !== "") {
      cwd = cwd.slice(0, cwd.lastIndexOf("/"));
      const notFound = file(`${cwd}/404.html`);
      if (notFound !== null) {
        send(response, 404, url.pathname, notFound);
        return;
      }
    }
    send(response, 404, url.pathname, null);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) =>
        server.close(() => {
          r();
        }),
      );
    },
  };
}
