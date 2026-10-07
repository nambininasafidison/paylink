// SPDX-License-Identifier: MIT
/**
 * The deploy page's committed artefacts are exactly what their generators produce today: data/*.json (from
 * @paylink/chains and the protocol release), vendor/* (from the pinned viem), and the CSP in index.html and
 * web/_headers (from the registry's RPC origins).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { registry } from "@paylink/chains";
import { describe, expect, it } from "vitest";
import { CREATE2_PROXY_PRESIGNED_TX, DEPLOY_CHAIN_IDS, proxyDeployment, renderAll, renderReleaseData, sourceCommit } from "../scripts/generate.ts";
import { buildVendor } from "../scripts/vendor.ts";

const repo = (path: string): string => new URL(`../../../${path}`, import.meta.url).pathname;
const read = (path: string): string => readFileSync(repo(path), "utf8");

describe("generated data (pnpm --filter @paylink/deploy-page run generate)", () => {
  it("is up to date", async () => {
    const { commit, shallow } = sourceCommit(repo(""));
    const committed = JSON.parse(read("web/v2/deploy/data/release.json")) as { sourceCommit: string };
    for (const [path, content] of await renderAll(repo(""), shallow ? committed.sourceCommit : commit)) {
      expect(read(path), path).toBe(content);
    }
  });

  it("names, as source commit, a commit whose release lock is today's", () => {
    const { commit, shallow } = sourceCommit(repo(""));
    if (shallow) {
      return;
    }
    const atCommit = execFileSync("git", ["-C", repo(""), "show", `${commit}:protocol/deployments/release.json`], { encoding: "utf8" });
    expect(atCommit).toBe(read("protocol/deployments/release.json"));
  });

  it("refuses init code that is not the release artifact", async () => {
    const release = read("protocol/deployments/release.json");
    await expect(renderReleaseData(release, "0x6080", "0".repeat(40))).rejects.toThrow(/not the release artifact/);
  });

  it("derives the proxy runtime from the canonical presigned transaction, not from a constant", async () => {
    const proxy = await proxyDeployment();
    expect(proxy.signer).toBe("0x3fAB184622Dc19b6109349B94811493BF2a45362");
    expect(proxy.factory).toBe("0x4e59b44847b379578588920cA78FbF26c0B4956C");
    expect(proxy.runtime).toBe(
      "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3",
    );
    expect(CREATE2_PROXY_PRESIGNED_TX.startsWith("0xf8a58085174876e800830186a0")).toBe(true);
  });

  it("deploys only to enabled v2 testnets of the registry", () => {
    for (const id of DEPLOY_CHAIN_IDS) {
      const chain = registry.getOrThrow(id);
      expect(chain).toMatchObject({ protocol: "v2", status: "enabled", testnet: true, local: false });
    }
  });
});

describe("vendored viem subset (pnpm --filter @paylink/deploy-page run vendor)", () => {
  it("rebuilds byte for byte from the pinned packages", async () => {
    const files = await buildVendor();
    for (const [name, content] of Object.entries(files)) {
      expect(read(`web/v2/deploy/vendor/${name}`), name).toBe(content);
    }
  });

  it("matches its SHA256SUMS", () => {
    const sums = read("web/v2/deploy/vendor/SHA256SUMS").trim().split("\n");
    expect(sums).toHaveLength(3);
    for (const line of sums) {
      const [hash, name] = line.split(/\s+/);
      expect(createHash("sha256").update(read(`web/v2/deploy/vendor/${name ?? ""}`)).digest("hex"), name).toBe(hash);
    }
  });
});

describe("content security policy", () => {
  const origins = DEPLOY_CHAIN_IDS.flatMap((id) => registry.getOrThrow(id).rpc.map((r) => new URL(r.url).origin));
  const directives = (policy: string): Map<string, string> =>
    new Map(
      policy
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d !== "")
        .map((d) => {
          const [name, ...values] = d.split(/\s+/);
          return [name ?? "", values.join(" ")];
        }),
    );
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(read("web/v2/deploy/index.html"))?.[1] ?? "";
  const header = /^\/v2\/\*\n(?:\s+.*\n)*?\s+Content-Security-Policy: (.+)$/m.exec(read("web/_headers"))?.[1] ?? "";

  it("lets the page reach exactly the registry RPCs of the deploy targets", () => {
    for (const policy of [meta, header]) {
      expect(directives(policy).get("connect-src")).toBe(["'self'", ...origins].join(" "));
    }
  });

  it("is the same policy in the header and the meta tag, plus frame-ancestors in the header", () => {
    const h = directives(header);
    expect(h.get("frame-ancestors")).toBe("'none'");
    h.delete("frame-ancestors");
    expect(h).toEqual(directives(meta));
    expect(directives(meta).get("script-src")).toBe("'self'");
    expect(directives(meta).get("default-src")).toBe("'none'");
  });

  it("scopes the headers to /v2/*, so the frozen v1 app keeps its own", () => {
    const rules = read("web/_headers")
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("#") && !/^\s/.test(l));
    expect(rules).toEqual(["/v2/*"]);
  });
});
