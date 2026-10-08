// SPDX-License-Identifier: MIT
/**
 * What Cloudflare deploys: deploy/wrangler.toml and the committed bundle. The bundle must equal a rebuild from this
 * tree (`build:check`), wrangler 4.148.0 must accept the configuration and upload exactly the committed bytes, and
 * the configuration must never carry the key.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELAYER_VERSION } from "../../src/core/version.ts";
import { buildWorker, DEPLOY_DIR, EXPECTED_PACKAGES } from "../../scripts/build.ts";

const PACKAGE_DIR = new URL("../../", import.meta.url).pathname;
const read = (name: string): string => readFileSync(join(DEPLOY_DIR, name), "utf8");
const toml = read("wrangler.toml");
const setting = (name: string): string | undefined => new RegExp(`^${name}\\s*=\\s*(.+)$`, "mu").exec(toml)?.[1]?.trim();

describe("deploy/wrangler.toml", () => {
  it("deploys the committed bundle as the paylink-relayer Worker on workers.dev, without previews", () => {
    expect(setting("name")).toBe('"paylink-relayer"');
    expect(setting("main")).toBe('"worker.js"');
    expect(setting("no_bundle")).toBe("true");
    expect(setting("find_additional_modules")).toBe("false");
    expect(setting("workers_dev")).toBe("true");
    expect(setting("preview_urls")).toBe("false");
    expect(setting("compatibility_date")).toMatch(/^"2026-\d\d-\d\d"$/u);
  });

  it("binds one SQLite-backed Durable Object class, which the Workers Free plan allows", () => {
    expect(toml).toMatch(/\[\[durable_objects\.bindings\]\]\s+name = "CHAIN_SENDER"\s+class_name = "ChainSender"/u);
    expect(toml).toMatch(/\[\[migrations\]\]\s+tag = "v1"\s+new_sqlite_classes = \["ChainSender"\]/u);
    expect(toml).not.toMatch(/new_classes/u);
  });

  it("carries no variables and never the key", () => {
    expect(toml).not.toMatch(/^\s*\[vars\]/mu);
    expect(toml).not.toMatch(/^\s*RELAYER_PK\s*=/mu);
    expect(toml).not.toMatch(/0x[0-9a-fA-F]{64}/u);
  });
});

describe("deploy/worker.js", () => {
  it("equals a rebuild from this tree (pnpm --filter @paylink/relayer run build:check)", async () => {
    const files = await buildWorker();
    expect(read("worker.js")).toBe(files["worker.js"]);
    expect(read("LICENSES.txt")).toBe(files["LICENSES.txt"]);
    expect(read("SHA256SUMS")).toBe(files.SHA256SUMS);
  });

  it("is listed in SHA256SUMS with wrangler.toml and the licences", () => {
    const sums = new Map(read("SHA256SUMS").trim().split("\n").map((line) => {
      const [digest = "", name = ""] = line.split(/\s+/u);
      return [name, digest] as const;
    }));
    for (const name of ["worker.js", "LICENSES.txt", "wrangler.toml"]) {
      expect(sums.get(name)).toBe(createHash("sha256").update(read(name)).digest("hex"));
    }
  });

  it("names its provenance, contains only allowlisted MIT packages and no Node built-in", () => {
    const js = read("worker.js");
    expect(js.split("\n", 7).join("\n")).toMatch(/GENERATED, DO NOT EDIT[\s\S]*shipped @paylink\/chains registry/u);
    for (const [name, version] of Object.entries(EXPECTED_PACKAGES)) {
      expect(js).toContain(`//#region ${name}@${version}/`);
    }
    expect(js).not.toMatch(/from\s*["']node:/u);
    expect(js).not.toMatch(/\.pnpm\//u);
    expect(js).toContain('import { DurableObject } from "cloudflare:workers";');
    expect(js).toMatch(/export \{[^}]*ChainSender[^}]*\}/u);
  });

  it("is accepted by wrangler 4.148.0, which uploads exactly the committed bytes with the Durable Object binding", () => {
    const out = mkdtempSync(join(tmpdir(), "relayer-dry-run-"));
    try {
      const result = spawnSync(join(PACKAGE_DIR, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", out], {
        cwd: DEPLOY_DIR,
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" },
        timeout: 120_000,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toMatch(/env\.CHAIN_SENDER \(ChainSender\)\s+Durable Object/u);
      expect(result.stdout).toContain("--dry-run: exiting now.");
      expect(readFileSync(join(out, "worker.js"), "utf8")).toBe(read("worker.js"));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("version", () => {
  it("reports the package version", () => {
    expect(RELAYER_VERSION).toBe((JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }).version);
  });
});
