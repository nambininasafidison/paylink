// SPDX-License-Identifier: MIT
/**
 * Mezo testnet rehearsed on an anvil fork (scripts/mezo-fork.ts, ADR 0017), against the chain's real state: the
 * CREATE2 factory and MUSD as Mezo testnet holds them. Needs anvil, `forge build` in protocol/ and egress to
 * rpc.test.mezo.org, so it runs only on request:
 *
 *   PAYLINK_FORK_MEZO=1 NODE_USE_ENV_PROXY=1 pnpm --filter @paylink/deploy-page exec vitest run test/mezo-fork.test.ts
 *
 * Nothing is sent to Mezo testnet; the one live call is a read-only eth_estimateGas of the CREATE2 deployment.
 */
import { FORK_GAS_LIMITS, mezoTestnet, RELEASE } from "@paylink/chains";
import type { PayLinkFunction } from "@paylink/chains";
import { beforeAll, describe, expect, it } from "vitest";
import { MEZO, rehearse } from "../scripts/mezo-fork.ts";
import type { Rehearsal } from "../scripts/mezo-fork.ts";

const enabled = process.env["PAYLINK_FORK_MEZO"] === "1";

describe.skipIf(!enabled)("Mezo testnet on an anvil fork", () => {
  let r: Rehearsal;

  beforeAll(async () => {
    r = await rehearse({ measure: true, liveEstimate: true });
  }, 600_000);

  it("forks the real chain: 31611, the canonical CREATE2 factory, MUSD with domain Mezo USD/1", () => {
    expect(r.chainId).toBe(MEZO.chainId);
    expect(r.factory).toEqual({ address: RELEASE.create2.factory, runtimeIsCanonical: true });
    expect(r.musd).toEqual({ domainSeparatorMatches: true, name: "Mezo USD", version: "1", borrowerOperationsMints: true });
  });

  it("deploys PayLinkV2 with the deploy kit at the CREATE2 address, verified by the kit and by tools/verify-deployment", () => {
    expect(r.deployment.planned).toEqual({ kind: "deploy", method: "CREATE2", address: RELEASE.create2.address });
    expect(r.deployment.address).toBe(RELEASE.create2.address);
    expect(r.deployment.verified).toBe(true);
    expect(r.deployment.checks.map((c) => c.id)).toEqual(["chain", "code", "runtime", "metadata", "immutables", "domain", "tx-chain", "tx-status", "tx-input", "tx-address"]);
    expect(r.deployment.checks.every((c) => c.ok)).toBe(true);
    expect(r.deployment.cliRecordIdentical).toBe(true);
    const record = JSON.parse(r.deployment.record) as { chainId: number; network: string; address: string; deployment: { method: string; factory: string }; explorers: { name: string; address: string }[] };
    expect(record).toMatchObject({ chainId: 31611, network: "Mezo testnet", address: RELEASE.create2.address, deployment: { method: "CREATE2", factory: RELEASE.create2.factory } });
    expect(record.explorers).toEqual([expect.objectContaining({ name: "Mezo Explorer", address: `https://explorer.test.mezo.org/address/${RELEASE.create2.address}` })]);
    // The kit's limit: clamp(estimate x 1.10, floor, ceiling) with the fork-measured bounds; Mezo testnet's own
    // estimator agrees with the fork's.
    expect(r.deployment.gasLimit).toBe((r.deployment.estimate * 110n + 99n) / 100n);
    expect(r.deployment.liveEstimate).toBe(r.deployment.estimate);
  });

  it("routes MUSD to permit, then approve-pay; never to an EIP-3009 authorisation", () => {
    expect(r.routes.eoa).toMatchObject({ available: true, path: "permit", fallbacks: ["approve-pay"], payerPaysGas: true });
    expect(r.routes.smartAccount).toMatchObject({ available: true, path: "approve-pay", fallbacks: [] });
    expect(r.routes.authorizationRefusedBySdk).toBe("E_TOKEN_NOT_EIP3009");
    expect(r.authorization.reverted).toBe(true);
  });

  it("moves exactly the invoice amount on every route, and every receipt verifies", () => {
    expect(r.payments.map((p) => p.route)).toEqual(["permit", "approve-pay", "native"]);
    for (const p of r.payments) {
      expect(p.after.payee - p.before.payee, p.route).toBe(p.amount);
      expect(p.before.payer - p.after.payer - (p.route === "native" ? p.gasFee : 0n), p.route).toBe(p.amount);
      expect(p.after.payLink, p.route).toBe(0n);
      expect(p.receipt.valid, p.route).toBe(true);
      expect(p.receipt.amount, p.route).toBe(p.amount);
      expect(p.linkState, p.route).toEqual({ payments: 1, total: p.amount });
      expect(p.secondPayment, p.route).toBe("SoldOut");
      // Mezo charges at least half the limit: the registry's bounds keep that under the gas used.
      expect((p.gasLimit + 1n) / 2n, p.route).toBeLessThanOrEqual(p.gasUsed);
    }
    const [permit, approvePay] = r.payments;
    expect(permit?.amount).toBe(12_500_000_000_000_000_000n);
    expect(permit?.permitNonce).toEqual({ before: 0n, after: 1n });
    expect(permit?.allowanceAfter).toBe(0n);
    expect(approvePay?.allowanceAfter).toBe(0n);
  });

  it("lets a third party send a payee's signed cancellation (what a relayer could offer on Mezo)", () => {
    expect(r.cancelBySig.cancelled).toBe(true);
  });

  it("measures every entry point under the registry's Mezo bounds (spec §3.3.6 rule) and its 50 % minimum charge", () => {
    const measured = r.measurements ?? {};
    expect(Object.keys(measured).length).toBe(13);
    for (const [scenario, m] of Object.entries(measured)) {
      const fn = scenario.split("_")[0] as PayLinkFunction | "deploy";
      expect(m.estimate, scenario).toBeGreaterThanOrEqual(m.gasUsed);
      if (fn === "deploy") {
        continue;
      }
      const bounds = FORK_GAS_LIMITS.mezo[fn];
      const margin = (BigInt(m.estimate) * 110n + 99n) / 100n;
      expect(margin, scenario).toBeLessThanOrEqual(bounds.ceiling);
      const limit = margin < bounds.floor ? bounds.floor : margin;
      expect((limit * BigInt(mezoTestnet.gasModel.minChargedPercentOfLimit ?? 100) + 99n) / 100n, scenario).toBeLessThanOrEqual(BigInt(m.gasUsed));
    }
  });
});
