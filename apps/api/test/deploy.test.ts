// SPDX-License-Identifier: MIT
/**
 * What Cloudflare deploys (decision D-HOST): deploy/wrangler.toml and the committed bundle. wrangler 4.148.0 must
 * accept the configuration and upload exactly the committed bytes with every binding; the configuration names the
 * Worker `paylink-api`, binds Workers AI and the two SQLite Durable Objects, declares one cron, and never carries a
 * secret. Whether the bundle equals a rebuild of the current tree is the release gate `build:check` (scripts/build.ts),
 * run before a push meant for deployment: several workstreams change src/ at the same time.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED_PACKAGES, DEPLOY_DIR } from "../scripts/build.ts";

const PACKAGE_DIR = new URL("../", import.meta.url).pathname;
const read = (name: string): string => readFileSync(join(DEPLOY_DIR, name), "utf8");
const toml = read("wrangler.toml");
const setting = (name: string): string | undefined => new RegExp(`^${name}\\s*=\\s*(.+)$`, "mu").exec(toml)?.[1]?.trim();

describe("deploy/wrangler.toml", () => {
  it("deploys the committed bundle as the paylink-api Worker on workers.dev, without previews", () => {
    expect(setting("name")).toBe('"paylink-api"');
    expect(setting("main")).toBe('"worker.js"');
    expect(setting("no_bundle")).toBe("true");
    expect(setting("find_additional_modules")).toBe("false");
    expect(setting("workers_dev")).toBe("true");
    expect(setting("preview_urls")).toBe("false");
    expect(setting("compatibility_date")).toMatch(/^"2026-\d\d-\d\d"$/u);
  });

  it("binds Workers AI as AI (decision D-AI)", () => {
    expect(toml).toMatch(/^\[ai\]\s+binding = "AI"$/mu);
  });

  it("binds the Payee and Global SQLite-backed Durable Objects, which the Workers Free plan allows", () => {
    expect(toml).toMatch(/\[\[durable_objects\.bindings\]\]\s+name = "PAYEE"\s+class_name = "Payee"/u);
    expect(toml).toMatch(/\[\[durable_objects\.bindings\]\]\s+name = "GLOBAL"\s+class_name = "Global"/u);
    expect(toml).toMatch(/\[\[migrations\]\]\s+tag = "v1"\s+new_sqlite_classes = \["Payee", "Global"\]/u);
    expect(toml).not.toMatch(/new_classes/u);
  });

  it("declares exactly one cron, every minute (the Free plan allows 5 Cron Triggers per account)", () => {
    expect(toml).toMatch(/^\[triggers\]\s+crons = \["\* \* \* \* \*"\]$/mu);
    expect(toml.match(/crons\s*=/gu)).toHaveLength(1);
  });

  it("carries no variables and no secret", () => {
    expect(toml).not.toMatch(/^\s*\[vars\]/mu);
    for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "APPROVAL_HMAC_KEY", "SESSION_HMAC_KEY"]) {
      expect(toml).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, "mu"));
    }
    expect(toml).not.toMatch(/[0-9a-fA-F]{40,}/u);
  });
});

describe("deploy/worker.js", () => {
  it("is listed in SHA256SUMS with wrangler.toml and the licences", () => {
    const sums = new Map(
      read("SHA256SUMS")
        .trim()
        .split("\n")
        .map((line) => {
          const [digest = "", name = ""] = line.split(/\s+/u);
          return [name, digest] as const;
        }),
    );
    for (const name of ["worker.js", "LICENSES.txt", "wrangler.toml"]) {
      expect(sums.get(name), name).toBe(createHash("sha256").update(read(name)).digest("hex"));
    }
  });

  it("names its provenance, bundles only allowlisted MIT packages, no Node built-in, and exports the handlers and both Durable Objects only", () => {
    const js = read("worker.js");
    expect(js.split("\n", 7).join("\n")).toMatch(/GENERATED, DO NOT EDIT[\s\S]*No key, no wallet client/u);
    const bundled = [...js.matchAll(/^\/\/#region ((?:@[^/@]+\/)?[^/@]+)@([^/]+)\//gmu)].map((m) => [m[1] ?? "", m[2] ?? ""] as const);
    for (const [name, version] of bundled) {
      expect(ALLOWED_PACKAGES[name], `${name}@${version}`).toBe(version);
    }
    expect(js).not.toMatch(/from\s*["']node:/u);
    expect(js).not.toMatch(/\.pnpm\//u);
    expect(js).toContain('import { DurableObject } from "cloudflare:workers";');
    // The runtime treats every named export as an entrypoint: the handlers and the two classes, nothing else.
    expect(js.trimEnd().split("\n").at(-1)).toBe("export { Global, Payee, worker_default as default };");
  });

  it("is accepted by wrangler 4.148.0, which uploads exactly the committed bytes with every binding", () => {
    const out = mkdtempSync(join(tmpdir(), "api-dry-run-"));
    try {
      const result = spawnSync(join(PACKAGE_DIR, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", out], {
        cwd: DEPLOY_DIR,
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" },
        timeout: 120_000,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toMatch(/env\.PAYEE \(Payee\)\s+Durable Object/u);
      expect(result.stdout).toMatch(/env\.GLOBAL \(Global\)\s+Durable Object/u);
      expect(result.stdout).toMatch(/env\.AI\s+AI/u);
      expect(result.stdout).toContain("--dry-run: exiting now.");
      expect(readFileSync(join(out, "worker.js"), "utf8")).toBe(read("worker.js"));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
