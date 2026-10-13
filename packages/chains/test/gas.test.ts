// SPDX-License-Identifier: MIT
/**
 * Gas-limit bounds (PAYLINK-V2-SPEC §3.3.6): floor = snapshot, ceiling = 1.5 × snapshot, so that
 * clamp(estimate × 1.10, floor, ceiling) never cuts an ERC-1271 payee's payment short.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyForkPrecedence,
  CEILING_FACTOR,
  checkCoverage,
  deriveEmulatedBounds,
  deriveGasBounds,
  EMULATED_PROFILES,
  ESTIMATE_MARGIN,
  GAS_FUNCTIONS,
  parseForkMeasurements,
  parseMeasurements,
  ROUNDING,
} from "../scripts/generate.ts";
import type { ForkProfile, MeasuredProfile } from "../scripts/generate.ts";
import { EMULATED_GAS_LIMITS, FORK_GAS_LIMITS, GAS_MEASUREMENTS, GAS_PROFILE_PROVENANCE, GAS_SNAPSHOT_MEASUREMENTS, mezoTestnet, RELEASE, SNAPSHOT_GAS_LIMITS } from "../src/index.ts";
import type { PayLinkFunction } from "../src/index.ts";

const roundUp = (n: number): number => Math.ceil(n / 1000) * 1000;
const GAS_SNAPSHOT_STRINGS = Object.fromEntries(Object.entries(GAS_SNAPSHOT_MEASUREMENTS).map(([k, v]) => [k, v.toString()]));

describe("snapshot gas limits", () => {
  it("restates the spec rule independently (EOA payees set the floor, x1.5 ceiling, rounded up to 1,000)", () => {
    const m = GAS_SNAPSHOT_MEASUREMENTS;
    const expected: Record<PayLinkFunction, number> = {
      payWithAuthorization: Math.max(Number(m.payWithAuthorization_first), Number(m.payWithAuthorization_repeat)),
      pay: Math.max(Number(m.pay_first), Number(m.pay_repeat)),
      payWithPermit: Number(m.payWithPermit_first),
      payNative: Math.max(Number(m.payNative_first), Number(m.payNative_repeat)),
      cancel: Number(m.cancel),
      cancelBySig: Number(m.cancelBySig),
    };
    for (const fn of GAS_FUNCTIONS) {
      const floor = roundUp(expected[fn]);
      expect(SNAPSHOT_GAS_LIMITS[fn]).toEqual({ floor: BigInt(floor), ceiling: BigInt(roundUp(floor * 1.5)) });
    }
  });

  it("pins the current values (a change needs a reviewed snapshot update)", () => {
    expect(SNAPSHOT_GAS_LIMITS).toEqual({
      payWithAuthorization: { floor: 143_000n, ceiling: 215_000n },
      pay: { floor: 102_000n, ceiling: 153_000n },
      payWithPermit: { floor: 136_000n, ceiling: 204_000n },
      payNative: { floor: 98_000n, ceiling: 147_000n },
      cancel: { floor: 54_000n, ceiling: 81_000n },
      cancelBySig: { floor: 62_000n, ceiling: 93_000n },
    });
  });

  it("leaves room for ERC-1271 payees with the 10 % estimate margin", () => {
    const margin = (gas: bigint): bigint => (gas * ESTIMATE_MARGIN.numerator + ESTIMATE_MARGIN.denominator - 1n) / ESTIMATE_MARGIN.denominator;
    expect(margin(GAS_SNAPSHOT_MEASUREMENTS.payWithAuthorization_erc1271Payee)).toBeLessThanOrEqual(SNAPSHOT_GAS_LIMITS.payWithAuthorization.ceiling);
    expect(margin(GAS_SNAPSHOT_MEASUREMENTS.cancelBySig_erc1271Payee)).toBeLessThanOrEqual(SNAPSHOT_GAS_LIMITS.cancelBySig.ceiling);
  });

  it("uses the spec's constants", () => {
    expect([ESTIMATE_MARGIN.numerator, ESTIMATE_MARGIN.denominator]).toEqual([110n, 100n]);
    expect([CEILING_FACTOR.numerator, CEILING_FACTOR.denominator]).toEqual([3n, 2n]);
    expect(ROUNDING).toBe(1000n);
  });
});

describe("deriveGasBounds", () => {
  const minimal = {
    payWithAuthorization_first: "100000",
    pay_first: "90000",
    payWithPermit_first: "95000",
    payNative_first: "50000",
    cancel: "40000",
    cancelBySig: "45000",
  };

  it("derives bounds and keeps informational entries as measurements only", () => {
    const { limits, measurements } = deriveGasBounds({ ...minimal, deploy: "2700000", statesOf_256: "700000" });
    expect(limits.get("pay")).toEqual({ floor: 90_000n, ceiling: 135_000n });
    expect(limits.get("cancelBySig")).toEqual({ floor: 45_000n, ceiling: 68_000n });
    expect(measurements.get("deploy")).toBe(2_700_000n);
  });

  it("takes the larger of the first and repeat payments", () => {
    expect(deriveGasBounds({ ...minimal, pay_repeat: "90001" }).limits.get("pay")?.floor).toBe(91_000n);
    expect(deriveGasBounds({ ...minimal, pay_repeat: "1" }).limits.get("pay")?.floor).toBe(90_000n);
  });

  it.each([
    [{ ...minimal, pay_first: 90000 }, /must be a positive decimal string/],
    [{ ...minimal, pay_first: "0" }, /must be a positive decimal string/],
    [{ ...minimal, pay_first: "1e5" }, /must be a positive decimal string/],
    [{ ...minimal, transfer: "1" }, /unknown entry transfer/],
    [{ ...minimal, pay_cold: "1" }, /unknown variant pay_cold/],
    [{ ...minimal, cancelBySig: undefined }, /no EOA-payee measurement for cancelBySig/],
    [{ ...minimal, cancelBySig_erc1271Payee: "70000" }, /ERC-1271 payee needs 77000 gas with the margin, above the ceiling 68000/],
  ])("refuses %o", (snapshot, pattern) => {
    const cleaned = Object.fromEntries(Object.entries(snapshot).filter(([, v]) => v !== undefined));
    expect(() => deriveGasBounds(cleaned)).toThrow(pattern);
  });
});

const forkText = readFileSync(new URL("../data/fork-gas-measurements.json", import.meta.url), "utf8");
const forks = parseForkMeasurements(forkText, RELEASE.initCodeHash);

describe("gas measured on anvil per network (data/gas-measurements.json)", () => {
  const measured = parseMeasurements(readFileSync(new URL("../data/gas-measurements.json", import.meta.url), "utf8"), RELEASE.initCodeHash);
  const profileOf = (name: string): MeasuredProfile => {
    const found = measured.profiles[name];
    if (found === undefined) {
      throw new Error(`profile ${name} missing`);
    }
    return found;
  };

  it("Monad's own estimates exceed the snapshot ceilings, which is why Monad has its own table", () => {
    expect(() => {
      checkCoverage("monad", profileOf("monad"), deriveGasBounds({ ...GAS_SNAPSHOT_STRINGS }).limits);
    }).toThrow(/above the ceiling/);
    const monad = deriveEmulatedBounds(profileOf("monad")).limits;
    expect(Object.fromEntries(monad)).toEqual(EMULATED_GAS_LIMITS.monad);
  });

  it("every Ethereum-priced profile fits under the snapshot ceilings with the 10 % margin", () => {
    for (const name of ["ethereum", "base", "london"]) {
      expect(() => {
        checkCoverage(name, profileOf(name), deriveGasBounds({ ...GAS_SNAPSHOT_STRINGS }).limits);
      }).not.toThrow();
    }
    expect(EMULATED_PROFILES.has("monad")).toBe(true);
    expect(EMULATED_PROFILES.has("ethereum")).toBe(false);
  });

  it("estimates are the gas limits clients need: at least the receipt's gas used", () => {
    expect(Object.keys(GAS_MEASUREMENTS).sort()).toEqual([...Object.keys(measured.profiles), ...Object.keys(forks)].sort());
    for (const profile of [...Object.values(measured.profiles), ...Object.values(forks)]) {
      for (const m of Object.values(profile.measurements)) {
        expect(m.estimate).toBeGreaterThanOrEqual(m.gasUsed);
      }
    }
  });

  const file = (patch: (f: Record<string, unknown>) => void): string => {
    const f = JSON.parse(readFileSync(new URL("../data/gas-measurements.json", import.meta.url), "utf8")) as Record<string, unknown>;
    patch(f);
    return JSON.stringify(f);
  };
  const profile = (f: Record<string, unknown>): Record<string, unknown> => (f["profiles"] as Record<string, Record<string, unknown>>)["monad"] ?? {};

  it.each<[string, (f: Record<string, unknown>) => void, RegExp]>([
    ["schema", (f) => (f["schema"] = "x"), /schema/],
    ["build", (f) => (f["initCodeHash"] = "0x00"), /another build/],
    ["tool", (f) => (f["tool"] = 1), /tool missing/],
    ["chainId", (f) => (profile(f)["chainId"] = 0), /profile monad/],
    ["appliesTo", (f) => (profile(f)["appliesTo"] = ["10143"]), /appliesTo/],
    ["estimate", (f) => ((profile(f)["measurements"] as Record<string, Record<string, unknown>>)["cancel"] = { estimate: 0, gasUsed: 1 }), /positive estimate/],
  ])("refuses a bad %s", (_what, patch, pattern) => {
    expect(() => parseMeasurements(file(patch), RELEASE.initCodeHash)).toThrow(pattern);
  });

  it("refuses a scenario without function bounds", () => {
    const lone: MeasuredProfile = { chainId: 1, hardfork: "x", network: "x", appliesTo: [1], measurements: { cancel: { estimate: 1, gasUsed: 1 } } };
    expect(() => {
      checkCoverage("x", lone, new Map());
    }).toThrow(/no function bounds/);
  });
});

describe("gas measured on an anvil fork of the chain itself (data/fork-gas-measurements.json)", () => {
  const found = forks["mezo"];
  if (found === undefined) {
    throw new Error("fork profile mezo missing");
  }
  const mezo: ForkProfile = found;
  const margin = (gas: number): bigint => (BigInt(gas) * ESTIMATE_MARGIN.numerator + ESTIMATE_MARGIN.denominator - 1n) / ESTIMATE_MARGIN.denominator;
  const clamp = (estimate: number, bounds: { floor: bigint; ceiling: bigint }): bigint => {
    const limit = margin(estimate);
    return limit < bounds.floor ? bounds.floor : limit > bounds.ceiling ? bounds.ceiling : limit;
  };

  it("measures Mezo testnet at a recorded block, through its own RPC, with every entry point", () => {
    expect(mezo).toMatchObject({ chainId: 31611, appliesTo: [31611], fork: { rpc: "https://rpc.test.mezo.org" } });
    expect(mezo.fork.block).toBeGreaterThan(16_000_000);
    expect(Object.keys(mezo.measurements).sort()).toEqual(Object.keys(GAS_MEASUREMENTS.ethereum.measurements).sort());
  });

  it("derives Mezo's bounds from the fork's estimates with the spec rule, ERC-1271 payees included", () => {
    const derived = deriveEmulatedBounds(mezo).limits;
    expect(Object.fromEntries(derived)).toEqual(FORK_GAS_LIMITS.mezo);
    expect(mezoTestnet.gas?.limits).toEqual(FORK_GAS_LIMITS.mezo);
    expect(() => {
      checkCoverage("mezo", mezo, derived);
    }).not.toThrow();
  });

  it("keeps Mezo's 50 % minimum charge below the gas used of every measured payment and cancellation", () => {
    // Mezo charges max(gas used, 50 % of the limit) (mezod MinGasMultiplier 0.5): with the clamp, never more than used.
    expect(mezoTestnet.gasModel.minChargedPercentOfLimit).toBe(50);
    const percent = BigInt(mezoTestnet.gasModel.minChargedPercentOfLimit ?? 100);
    for (const [scenario, m] of Object.entries(mezo.measurements)) {
      const fn = scenario.split("_")[0] as PayLinkFunction | "deploy";
      if (fn === "deploy") {
        continue;
      }
      const limit = clamp(m.estimate, FORK_GAS_LIMITS.mezo[fn]);
      expect((limit * percent + 99n) / 100n, scenario).toBeLessThanOrEqual(BigInt(m.gasUsed));
    }
  });

  it("pins the values (a change needs a reviewed re-measurement)", () => {
    expect(FORK_GAS_LIMITS.mezo).toEqual({
      payWithAuthorization: { floor: 167_000n, ceiling: 251_000n },
      pay: { floor: 112_000n, ceiling: 168_000n },
      payWithPermit: { floor: 161_000n, ceiling: 242_000n },
      payNative: { floor: 102_000n, ceiling: 153_000n },
      cancel: { floor: 58_000n, ceiling: 87_000n },
      cancelBySig: { floor: 67_000n, ceiling: 101_000n },
    });
    // The CREATE2 deployment as Mezo testnet's own eth_estimateGas gave it (docs/research/mezo.md §3).
    expect(mezo.measurements["deploy_create2"]?.estimate).toBe(2_717_457);
    // payWithPermit with MUSD, as in the research smoke test (docs/research/mezo.md §5).
    expect(mezo.measurements["payWithPermit_first"]?.gasUsed).toBe(135_733);
  });

  it("names its provenance apart from the measurements, which clients do not ship", () => {
    for (const [name, profile] of Object.entries(GAS_MEASUREMENTS)) {
      const cited = GAS_PROFILE_PROVENANCE[name as keyof typeof GAS_PROFILE_PROVENANCE];
      expect(cited.hardfork, name).toBe(profile.hardfork);
      expect("forkBlock" in cited ? cited.forkBlock : null, name).toBe("fork" in profile ? profile.fork.block : null);
    }
    expect(mezoTestnet.gas?.evidence).toContain(`at block ${String(mezo.fork.block)} (hardfork Prague)`);
  });

  it("supersedes the emulation profiles for the chains it measures, and only those", () => {
    const anvil = parseMeasurements(readFileSync(new URL("../data/gas-measurements.json", import.meta.url), "utf8"), RELEASE.initCodeHash).profiles;
    expect(anvil["london"]?.appliesTo).toEqual([31611]);
    const merged = applyForkPrecedence(anvil, forks);
    expect(merged["london"]?.appliesTo).toEqual([]);
    expect(merged["base"]?.appliesTo).toEqual([84532]);
    expect(merged["mezo"]).toBe(mezo);
    const london = anvil["london"];
    expect(london).toBeDefined();
    expect(() => applyForkPrecedence(london === undefined ? {} : { mezo: london }, forks)).toThrow(/both an anvil profile and a fork/);
  });

  const forkFile = (patch: (f: Record<string, unknown>) => void): string => {
    const f = JSON.parse(forkText) as Record<string, unknown>;
    patch(f);
    return JSON.stringify(f);
  };
  const profile = (f: Record<string, unknown>): Record<string, unknown> => (f["profiles"] as Record<string, Record<string, unknown>>)["mezo"] ?? {};

  it.each<[string, (f: Record<string, unknown>) => void, RegExp]>([
    ["schema", (f) => (f["schema"] = "paylink.gas-measurements/1"), /schema/],
    ["build", (f) => (f["initCodeHash"] = "0x00"), /another build/],
    ["tool", (f) => (f["tool"] = null), /tool missing/],
    ["fork point", (f) => (profile(f)["fork"] = { rpc: "http://127.0.0.1:8545", block: 1, blockHash: `0x${"00".repeat(32)}`, timestamp: 1 }), /needs fork/],
    ["fork block", (f) => (profile(f)["fork"] = { ...(profile(f)["fork"] as object), block: 0 }), /needs fork/],
    ["twice", (f) => ((f["profiles"] as Record<string, unknown>)["other"] = profile(f)), /measured on two forks/],
    ["measurement", (f) => ((profile(f)["measurements"] as Record<string, unknown>)["cancel"] = { estimate: 1, gasUsed: 0 }), /positive estimate/],
  ])("refuses a bad %s", (_what, patch, pattern) => {
    expect(() => parseForkMeasurements(forkFile(patch), RELEASE.initCodeHash)).toThrow(pattern);
  });
});
