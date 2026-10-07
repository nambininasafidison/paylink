// SPDX-License-Identifier: MIT
/**
 * Deployment gas (PAYLINK-V2-SPEC §3.3.6, §3.3.7): the deploy page clamps eth_estimateGas × 1.10 to bounds measured
 * on the anvil profile of each chain, because Monad charges the whole gas limit.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEPLOY_SCENARIOS, deriveDeployGas, parseMeasurements } from "../scripts/generate.ts";
import type { MeasuredProfile } from "../scripts/generate.ts";
import { DEPLOY_GAS, deployGasFor, GAS_MEASUREMENTS, RELEASE, registry } from "../src/index.ts";

const roundUp = (n: number): bigint => BigInt(Math.ceil(n / 1000) * 1000);
const measured = parseMeasurements(readFileSync(new URL("../data/gas-measurements.json", import.meta.url), "utf8"), RELEASE.initCodeHash);

describe("deployGasFor", () => {
  it("covers every v2 chain with the profile that emulates it", () => {
    for (const chain of registry.chains.filter((c) => c.protocol === "v2")) {
      const table = deployGasFor(chain.chainId);
      expect(table, chain.name).not.toBeNull();
      expect((GAS_MEASUREMENTS[table?.profile as keyof typeof GAS_MEASUREMENTS].appliesTo as readonly number[]).includes(chain.chainId)).toBe(true);
    }
    expect(deployGasFor(10143)?.profile).toBe("monad");
    expect(deployGasFor(10143)?.hardfork).toBe("MonadTen");
    expect(deployGasFor(84532)?.profile).toBe("base");
    expect(deployGasFor(421614)?.profile).toBe("ethereum");
  });

  it("returns null for chains no profile measures", () => {
    expect(deployGasFor(5042)).toBeNull();
    expect(deployGasFor(31337)).toBeNull();
    expect(deployGasFor(1)).toBeNull();
  });

  it("restates the rule independently: floor = estimate, ceiling = 1.5 x floor, both rounded up to 1,000", () => {
    for (const [name, profile] of Object.entries(measured.profiles)) {
      for (const method of ["create", "create2"] as const) {
        const m = profile.measurements[DEPLOY_SCENARIOS[method]];
        expect(m, `${name}.${method}`).toBeDefined();
        const floor = roundUp(m?.estimate ?? 0);
        const entry = DEPLOY_GAS[name as keyof typeof DEPLOY_GAS][method];
        expect(entry).toEqual({ estimate: BigInt(m?.estimate ?? 0), gasUsed: BigInt(m?.gasUsed ?? 0), floor, ceiling: roundUp(Number(floor) * 1.5) });
        expect(entry.gasUsed).toBeLessThanOrEqual(entry.estimate);
      }
    }
  });

  it("pins Monad's values (a change needs a reviewed re-measurement)", () => {
    expect(deployGasFor(10143)).toMatchObject({
      provisional: true,
      create: { estimate: 2_677_645n, floor: 2_678_000n, ceiling: 4_017_000n },
      create2: { estimate: 2_720_773n, floor: 2_721_000n, ceiling: 4_082_000n },
    });
  });

  it("CREATE2 through the factory costs more than CREATE (the proxy call and the salt)", () => {
    for (const entry of Object.values(DEPLOY_GAS)) {
      expect(entry.create2.estimate).toBeGreaterThan(entry.create.estimate);
    }
  });
});

describe("deriveDeployGas", () => {
  const base: MeasuredProfile = {
    chainId: 1,
    hardfork: "x",
    network: "x",
    appliesTo: [1],
    measurements: { deploy_create: { estimate: 2_000_001, gasUsed: 2_000_000 }, deploy_create2: { estimate: 2_100_000, gasUsed: 2_050_000 } },
  };

  it("derives both methods", () => {
    expect(deriveDeployGas("x", base)).toEqual({
      create: { estimate: 2_000_001n, gasUsed: 2_000_000n, floor: 2_001_000n, ceiling: 3_002_000n },
      create2: { estimate: 2_100_000n, gasUsed: 2_050_000n, floor: 2_100_000n, ceiling: 3_150_000n },
    });
  });

  it("refuses a profile without a deployment measurement", () => {
    expect(() => deriveDeployGas("x", { ...base, measurements: { deploy_create: { estimate: 1, gasUsed: 1 } } })).toThrow(/x has no deploy_create2 measurement/);
  });

  it("refuses a measurement whose receipt used more than its estimate", () => {
    expect(() => deriveDeployGas("x", { ...base, measurements: { ...base.measurements, deploy_create: { estimate: 1, gasUsed: 2 } } })).toThrow(/used more gas than its estimate/);
  });
});
