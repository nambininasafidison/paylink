// SPDX-License-Identifier: MIT
/**
 * PAYLINK-V2-SPEC §3.4: "every address passes an EIP-55 test", and only addresses from the spec, with their
 * confidence tags, enter the registry. The spec's addresses are mirrored, with their source and tag, in
 * docs/tools/address-allowlist.json (also enforced on the documentation by docs/tools/check-docs.py), so the
 * registry is checked against that file in both directions.
 */
import { readFileSync } from "node:fs";
import { getAddress, isAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { RELEASE, registry } from "../src/index.ts";

interface AllowlistEntry {
  readonly address: string;
  readonly chainId: number | null;
  readonly use: "registry" | "never" | "helper" | "protocol" | "fixture" | "dropped";
  readonly confidence: string;
}

const allowlist = (
  JSON.parse(readFileSync(new URL("../../../docs/tools/address-allowlist.json", import.meta.url), "utf8")) as {
    addresses: AllowlistEntry[];
  }
).addresses;

type Use = AllowlistEntry["use"];
interface Found {
  readonly where: string;
  readonly chainId: number | null;
  readonly address: string;
  readonly use: Use;
  readonly confidence?: string;
}

/** Every address the registry holds, with the allowlist "use" it must have. */
function registryAddresses(): Found[] {
  const found: Found[] = [];
  for (const chain of registry.chains) {
    for (const token of chain.tokens) {
      found.push({
        where: `${chain.name} token ${token.symbol}`,
        chainId: token.kind === "native" ? null : chain.chainId,
        address: token.address,
        use: token.kind === "native" ? "protocol" : "registry",
        confidence: token.confidence,
      });
    }
    for (const denied of chain.deniedTokens) {
      found.push({ where: `${chain.name} denied`, chainId: chain.chainId, address: denied.address, use: "never", confidence: denied.confidence });
    }
    for (const [name, helper] of Object.entries(chain.contracts)) {
      const chainId = name === "create2Deployer" ? null : chain.chainId;
      found.push({ where: `${chain.name} ${name}`, chainId, address: helper.address, use: "helper", confidence: helper.confidence });
    }
    if (chain.deployment !== null) {
      found.push({ where: `${chain.name} deployment`, chainId: chain.chainId, address: chain.deployment.address, use: "registry" });
    }
    if (chain.v1 !== null && chain.v1.address !== null) {
      found.push({ where: `${chain.name} v1`, chainId: chain.chainId, address: chain.v1.address, use: "registry" });
    }
  }
  return found;
}

describe("EIP-55", () => {
  const all = [
    ...registryAddresses().map((f) => [f.where, f.address] as const),
    ["release CREATE2 factory", RELEASE.create2.factory] as const,
    ["release CREATE2 address", RELEASE.create2.address] as const,
  ];

  it.each(all)("%s is EIP-55 checksummed (%s)", (_where, address) => {
    expect(isAddress(address, { strict: true })).toBe(true);
    expect(getAddress(address)).toBe(address);
  });

  it("rejects the …dCF7c typo printed in Base's docs (spec §3.4)", () => {
    const typo = "0x036CbD53842c5426634e7929541eC2318f3dCF7c";
    expect(isAddress(typo, { strict: true })).toBe(false);
    expect(registry.findToken(84532, typo)).toBeUndefined();
  });

  it("covers a meaningful number of addresses", () => {
    expect(all.length).toBeGreaterThanOrEqual(18);
  });
});

describe("allowlist parity (docs/tools/address-allowlist.json)", () => {
  const found = registryAddresses();

  it.each(found.map((f) => [f.where, f] as const))("%s is allowlisted with the same chain, use and confidence", (_where, f) => {
    const entry = allowlist.find((a) => a.address === f.address && a.chainId === f.chainId);
    expect(entry, `${f.address} on chain ${String(f.chainId)} is not in the allowlist`).toBeDefined();
    expect(entry?.use).toBe(f.use);
    if (f.confidence !== undefined && f.use !== "protocol") {
      expect(entry?.confidence).toBe(f.confidence);
    }
  });

  it("holds every spec address of the chains it covers (registry, deny-list and helpers)", () => {
    const chainIds = new Set(registry.chains.map((c) => c.chainId));
    const relevant = allowlist.filter(
      (a) => a.chainId !== null && chainIds.has(a.chainId) && (a.use === "registry" || a.use === "never" || a.use === "helper"),
    );
    for (const entry of relevant) {
      expect(
        found.some((f) => f.address === entry.address && f.chainId === entry.chainId),
        `${entry.address} (chain ${String(entry.chainId)}, ${entry.use}) is missing from the registry`,
      ).toBe(true);
    }
    expect(relevant.length).toBeGreaterThanOrEqual(15);
  });

  it("only native tokens use the zero address", () => {
    for (const f of found) {
      expect(f.address === zeroAddress).toBe(f.use === "protocol");
    }
  });
});
