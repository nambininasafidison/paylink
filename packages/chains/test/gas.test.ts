// SPDX-License-Identifier: MIT
/**
 * Gas-limit bounds (PAYLINK-V2-SPEC §3.3.6): floor = snapshot, ceiling = 1.5 × snapshot, so that
 * clamp(estimate × 1.10, floor, ceiling) never cuts an ERC-1271 payee's payment short.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CEILING_FACTOR,
  checkCoverage,
  deriveEmulatedBounds,
  deriveGasBounds,
  EMULATED_PROFILES,
  ESTIMATE_MARGIN,
  GAS_FUNCTIONS,
  parseMeasurements,
  ROUNDING,
} from "../scripts/generate.ts";
import type { MeasuredProfile } from "../scripts/generate.ts";
import { EMULATED_GAS_LIMITS, GAS_MEASUREMENTS, GAS_SNAPSHOT_MEASUREMENTS, RELEASE, SNAPSHOT_GAS_LIMITS } from "../src/index.ts";
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
    expect(Object.keys(GAS_MEASUREMENTS).sort()).toEqual(Object.keys(measured.profiles).sort());
    for (const profile of Object.values(measured.profiles)) {
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
