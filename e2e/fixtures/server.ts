// SPDX-License-Identifier: MIT
/**
 * Serves web/ the way Cloudflare Pages does for this project (root "web", no build), including the response headers
 * of web/_headers, so the e2e suite runs the page under its production Content-Security-Policy.
 */
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const WEB_ROOT = join(REPO, "web");

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
};

/** Cloudflare Pages `_headers`: a path pattern line, then indented `Name: value` lines. Only `*` suffixes are used here. */
export function parseHeaders(text: string): { pattern: string; headers: [string, string][] }[] {
  const rules: { pattern: string; headers: [string, string][] }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (!/^\s/.test(line)) {
      rules.push({ pattern: line.trim(), headers: [] });
      continue;
    }
    const at = line.indexOf(":");
    rules.at(-1)?.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return rules;
}

const matches = (pattern: string, path: string): boolean => (pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern);

export interface StaticServer {
  readonly origin: string;
  close(): Promise<void>;
}

export async function serveWeb(): Promise<StaticServer> {
  const rules = parseHeaders(readFileSync(join(WEB_ROOT, "_headers"), "utf8"));
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let path = normalize(join(WEB_ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(WEB_ROOT + sep) && path !== WEB_ROOT) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (statSync(path).isDirectory()) {
        path = join(path, "index.html");
      }
      const body = readFileSync(path);
      for (const rule of rules) {
        if (matches(rule.pattern, url.pathname)) {
          for (const [name, value] of rule.headers) {
            response.setHeader(name, value);
          }
        }
      }
      response.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
      response.setHeader("cache-control", "no-store");
      response.writeHead(200).end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => {
        r();
      }));
    },
  };
}
