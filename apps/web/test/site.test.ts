// @vitest-environment node
// SPDX-License-Identifier: MIT
/**
 * The production site for Cloudflare Pages (scripts/site.ts, docs/runbooks/cloudflare-pages.md): one folder with the
 * v2 app, the frozen v1 app under /arc/ byte for byte, the deploy kit under /deploy/ and /v2/deploy/, and `_headers`
 * with one Content-Security-Policy per area.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, scopeToEdition } from "@paylink/chains";
import { afterAll, describe, expect, it } from "vitest";
import { entryJsBytes } from "../scripts/build.ts";
import { appCsp, assemble, configOrigins, DEFAULT_EDITIONS, deployCsp, KIT, kitIndexHtml, PUBLIC, renderHeaders, rpcOrigins, v1Csp, v1Files, v1ScriptHashes, WEB } from "../scripts/site.ts";

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy.split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The rules of a `_headers` file: path → its lines. */
function rules(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("/")) {
      current = [];
      map.set(line, current);
    } else if (line.startsWith("  ") && current !== null) {
      current.push(line.trim());
    }
  }
  return map;
}

describe("_headers", () => {
  it("is committed up to date (pnpm --filter @paylink/web run headers)", () => {
    expect(readFileSync(join(PUBLIC, "_headers"), "utf8")).toBe(renderHeaders());
  });

  it("gives the app a strict policy: own scripts and styles only, Trusted Types, no framing", () => {
    const csp = directives(appCsp([...rpcOrigins(), ...configOrigins()]));
    expect(csp.get("default-src")).toEqual(["'none'"]);
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("style-src")).toEqual(["'self'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("form-action")).toEqual(["'none'"]);
    expect(csp.get("require-trusted-types-for")).toEqual(["'script'"]);
    expect(csp.get("trusted-types")).toEqual(["paylink-sw"]);
    expect([...csp.values()].flat().some((v) => /unsafe|\*|^http:|^data:$/.test(v) && v !== "data:")).toBe(false);
    expect(directives(appCsp([], true)).has("frame-ancestors")).toBe(false);
  });

  it("lets the app connect to its own origin, the registry RPCs of the built editions and config.json's endpoints only", () => {
    const expected = new Set<string>();
    for (const edition of DEFAULT_EDITIONS) {
      for (const chain of scopeToEdition(registry, edition).chains) {
        for (const rpc of chain.rpc) {
          expected.add(new URL(rpc.url).origin);
        }
      }
    }
    for (const origin of configOrigins()) {
      expected.add(origin);
    }
    const connect = directives(appCsp([...rpcOrigins(), ...configOrigins()])).get("connect-src") ?? [];
    expect(connect[0]).toBe("'self'");
    expect(new Set(connect.slice(1))).toEqual(expected);
    expect(connect.slice(1).every((origin) => origin.startsWith("https://"))).toBe(true);
    expect(configOrigins({ relayer: { url: "https://relayer.example/v1" }, indexer: null, rpc: { "10143": ["https://rpc.example:8443/x"] } })).toEqual(["https://relayer.example", "https://rpc.example:8443"]);
  });

  it("detaches the app's policy before setting each area's own (Cloudflare joins duplicate headers with a comma)", () => {
    const parsed = rules(renderHeaders());
    expect([...parsed.keys()].slice(0, 4)).toEqual(["/*", "/arc/*", "/deploy/*", "/v2/deploy/*"]);
    for (const area of ["/arc/*", "/deploy/*", "/v2/deploy/*"]) {
      expect(parsed.get(area)?.[0], area).toBe("! Content-Security-Policy");
      expect(parsed.get(area)?.filter((l) => l.startsWith("Content-Security-Policy:")), area).toHaveLength(1);
    }
    const base = parsed.get("/*") ?? [];
    for (const header of ["X-Content-Type-Options: nosniff", "X-Frame-Options: DENY", "Referrer-Policy: no-referrer", "Cross-Origin-Opener-Policy: same-origin"]) {
      expect(base, header).toContain(header);
    }
    const permissions = base.find((l) => l.startsWith("Permissions-Policy:")) ?? "";
    expect(permissions).toContain("publickey-credentials-get=(self)");
    expect(permissions).toContain("camera=()");
    expect(permissions).toContain("payment=()");
  });

  it("serves the frozen v1 app with exactly what it needs: its inline script by hash, its RPC", () => {
    const deployHtml = readFileSync(join(WEB, "deploy.html"), "utf8");
    const inline = [...deployHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1] ?? "").digest("base64")}'`);
    expect(inline.length).toBeGreaterThan(0);
    for (const hash of inline) {
      expect(v1ScriptHashes()).toContain(hash);
    }
    const csp = directives(v1Csp());
    expect(csp.get("script-src")).toEqual(["'self'", ...v1ScriptHashes()]);
    expect(csp.get("connect-src")).toEqual(["'self'", "https://rpc.mainnet.arc.io"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("serves the deploy kit under its own meta policy plus frame-ancestors, as web/_headers does for /v2/*", () => {
    const kitHtml = readFileSync(join(KIT, "index.html"), "utf8");
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(kitHtml)?.[1];
    expect(deployCsp()).toBe(`${meta ?? ""}; frame-ancestors 'none'`);
    const v1Headers = readFileSync(join(WEB, "_headers"), "utf8");
    expect(v1Headers).toContain(`Content-Security-Policy: ${deployCsp()}`);
  });
});

describe("assembly", () => {
  const dist = mkdtempSync(join(tmpdir(), "paylink-site-"));
  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  it("lists the v1 files: web/ without the deploy kit and its headers file", () => {
    const files = v1Files();
    for (const required of ["index.html", "deploy.html", "app.js", "paylink.css", "config.js", "qrcode.js", "ethers.umd.min.js"]) {
      expect(files, required).toContain(required);
    }
    expect(files.some((f) => f.startsWith("v2/") || f === "_headers")).toBe(false);
  });

  it("points the kit's two v1 links at /arc/, and changes nothing else", () => {
    const original = readFileSync(join(KIT, "index.html"), "utf8");
    const served = kitIndexHtml();
    expect(served).not.toContain("../../");
    expect(served).toContain('href="/arc/paylink.css"');
    expect(served.replaceAll('href="/arc/paylink.css"', 'href="../../paylink.css"').replaceAll('href="/arc/fonts/', 'href="../../fonts/')).toBe(original);
  });

  it("copies v1 byte for byte under /arc/, the kit under /deploy/ and /v2/deploy/, and writes _headers", () => {
    mkdirSync(join(dist, "monad"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    writeFileSync(join(dist, "404.html"), "<!doctype html>");
    writeFileSync(join(dist, "monad/config.json"), "{}");
    assemble(dist, ["all", "monad"]);
    for (const file of v1Files()) {
      expect(sha256(join(dist, "arc", file)), file).toBe(sha256(join(WEB, file)));
    }
    for (const area of ["deploy", "v2/deploy"]) {
      expect(sha256(join(dist, area, "app.js"))).toBe(sha256(join(KIT, "app.js")));
      expect(sha256(join(dist, area, "vendor/viem.js"))).toBe(sha256(join(KIT, "vendor/viem.js")));
      expect(readFileSync(join(dist, area, "index.html"), "utf8")).toBe(kitIndexHtml());
    }
    expect(readFileSync(join(dist, "_headers"), "utf8")).toBe(renderHeaders(["all", "monad"]));
    expect(() => readFileSync(join(dist, "monad/config.json"))).toThrow();
  });

  it("refuses a dist without the root edition", () => {
    const empty = mkdtempSync(join(tmpdir(), "paylink-empty-"));
    try {
      expect(() => {
        assemble(empty, ["all"]);
      }).toThrow(/root edition/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("pay route budget", () => {
  it("counts an entry's static imports transitively, gzipped, and leaves dynamic imports out", () => {
    const dir = mkdtempSync(join(tmpdir(), "paylink-manifest-"));
    try {
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "assets/pay.js"), "a".repeat(1000));
      writeFileSync(join(dir, "assets/shared.js"), "b".repeat(1000));
      writeFileSync(join(dir, "assets/lazy.js"), "c".repeat(100_000));
      const manifest = {
        "pay/index.html": { file: "assets/pay.js", isEntry: true, imports: ["_shared.js"], dynamicImports: ["_lazy.js"] },
        "_shared.js": { file: "assets/shared.js", imports: ["pay/index.html"] },
        "_lazy.js": { file: "assets/lazy.js" },
      };
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
      const bytes = entryJsBytes(dir, join(dir, "manifest.json"), "pay/index.html");
      expect(bytes).toBeGreaterThan(20);
      expect(bytes).toBeLessThan(200);
      expect(() => entryJsBytes(dir, join(dir, "manifest.json"), "nope.html")).toThrow(/no entry/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
