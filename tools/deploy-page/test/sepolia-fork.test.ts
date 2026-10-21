// SPDX-License-Identifier: MIT
/**
 * Ethereum Sepolia rehearsed on an anvil fork (scripts/sepolia-fork.ts, ADR 0018), against the chain's real state: the
 * CREATE2 factory, Circle USDC and PayPal USD as Sepolia holds them. Needs anvil and egress to
 * ethereum-sepolia-rpc.publicnode.com, so it runs only on request:
 *
 *   PAYLINK_FORK_SEPOLIA=1 NODE_USE_ENV_PROXY=1 pnpm --filter @paylink/deploy-page exec vitest run test/sepolia-fork.test.ts
 *
 * Nothing is sent to Sepolia.
 */
import { ethereumSepolia, RELEASE } from "@paylink/chains";
import { beforeAll, describe, expect, it } from "vitest";
import { rehearse, SEPOLIA } from "../scripts/sepolia-fork.ts";
import type { Rehearsal } from "../scripts/sepolia-fork.ts";

const enabled = process.env["PAYLINK_FORK_SEPOLIA"] === "1";

describe.skipIf(!enabled)("Ethereum Sepolia on an anvil fork", () => {
  let r: Rehearsal;

  beforeAll(async () => {
    r = await rehearse();
  }, 600_000);

  it("forks the real chain: 11155111, the canonical CREATE2 factory", () => {
    expect(r.chainId).toBe(SEPOLIA.chainId);
    expect(r.factory).toEqual({ address: RELEASE.create2.factory, runtimeIsCanonical: true });
  });

  it("holds both tokens as the registry states them; the SDK resolves PYUSD's domain without version()", () => {
    expect(r.tokens).toEqual([
      { symbol: "USDC", name: "USDC", decimals: 6, separatorMatchesRegistry: true, version: "2", erc5267: false, sdkDomain: "USDC/2" },
      { symbol: "PYUSD", name: "PayPal USD", decimals: 6, separatorMatchesRegistry: true, version: null, erc5267: false, sdkDomain: "PayPal USD/1" },
    ]);
  });

  it("deploys PayLinkV2 with the deploy kit at the CREATE2 address, verified by the kit and by tools/verify-deployment", () => {
    expect(r.deployment.planned).toEqual({ kind: "deploy", method: "CREATE2", address: RELEASE.create2.address });
    expect(r.deployment.address).toBe(RELEASE.create2.address);
    expect(r.deployment.verified).toBe(true);
    expect(r.deployment.checks.every((c) => c.ok)).toBe(true);
    expect(r.deployment.cliRecordIdentical).toBe(true);
    const record = JSON.parse(r.deployment.record) as { chainId: number; network: string; address: string; deployment: { method: string; factory: string }; explorers: { name: string; address: string }[] };
    expect(record).toMatchObject({ chainId: 11155111, network: "Ethereum Sepolia", address: RELEASE.create2.address, deployment: { method: "CREATE2", factory: RELEASE.create2.factory } });
    expect(record.explorers).toEqual([expect.objectContaining({ name: "Etherscan", address: `https://sepolia.etherscan.io/address/${RELEASE.create2.address}` })]);
    expect(r.deployment.gasLimit).toBe((r.deployment.estimate * 110n + 99n) / 100n);
  });

  it("routes a code-less payer to self-authorization, then permit, with no relayer", () => {
    expect(r.route).toMatchObject({ available: true, path: "self-authorization", fallbacks: ["permit", "approve-pay"], payerPaysGas: true });
  });

  it("pays USDC and PYUSD by authorisation and by permit: exact amounts, verified receipts, within the registry's gas bounds", () => {
    expect(r.payments.map((p) => [p.symbol, p.route])).toEqual([
      ["USDC", "self-authorization"],
      ["USDC", "permit"],
      ["PYUSD", "self-authorization"],
      ["PYUSD", "permit"],
    ]);
    for (const p of r.payments) {
      const what = `${p.symbol} ${p.route}`;
      expect(p.payeeDelta, what).toBe(p.amount);
      expect(p.payerDelta, what).toBe(p.amount);
      expect(p.payLinkBalance, what).toBe(0n);
      expect(p.allowanceAfter, what).toBe(0n);
      expect(p.receipt, what).toEqual({ valid: true, amount: p.amount });
      expect(p.linkState, what).toEqual({ payments: 1, total: p.amount });
      expect(p.secondPayment, what).toBe("SoldOut");
      // The snapshot bounds hold for both real tokens: the estimate stays under the ceiling and the gas used under the limit.
      expect(p.estimate, what).toBeLessThan(p.ceiling);
      expect(p.gasUsed, what).toBeLessThanOrEqual(p.gasLimit);
      expect(p.ceiling, what).toBe(ethereumSepolia.gas?.limits[p.route === "permit" ? "payWithPermit" : "payWithAuthorization"].ceiling);
    }
  });

  it("fails closed on PYUSD's silent no-op for a used EIP-3009 nonce", () => {
    expect(r.pyusdReplay).toEqual({ firstPaid: true, replayError: "ReceivedMismatch" });
  });
});
