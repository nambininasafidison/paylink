// SPDX-License-Identifier: MIT
/**
 * AUDIT-04 regression (2026-10-07 re-audit, medium). Before the fix the relayer pipeline admitted authorizations,
 * invoices and cancellations whose time bound was one second ahead, and `release(..., "reverted-after-simulation")`
 * banned the invoice key, the payee and the payer whoever caused the revert: a sybil payer holding one base unit
 * could sign `validBefore = now + 1` and shut an honest merchant out of the gasless path for a day, and a payer's own
 * spec §8.6 resubmission banned every honest party. The on-chain half (eth_call passes at T, the relay reverts at
 * T + 1, the attacker sends no transaction; the same authorization landing elsewhere reverts the relay) is pinned by
 * protocol/test/audit/A04_TimeBoundaryBan.t.sol, and the anvil suite replays the attribution on the real contract.
 *
 * Fixed by (invoice spec §13.3): a minimum remaining validity per chain (`chain.relay.minRemainingSeconds`, 120 s)
 * applied by `checkRelayPayRequest` and `checkRelayCancelRequest` and again by `RelayAdmissionLedger.admit`;
 * attribution by cause (`attributeRelayRevert`) with penalties per cause (`REVERT_PENALTIES`).
 */
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  authorizePayment,
  checkRelayCancelRequest,
  checkRelayPayRequest,
  decodeInvoiceFragment,
  isPayLinkError,
  issueInvoice,
  parseRelayPayRequest,
  RelayAdmissionLedger,
  requesterFromIp,
  signCancel,
  ZERO_HASH,
} from "../../src/index.ts";
import { CHAIN_ID, CONTRACT, payee, payer, registry, T0, TOKEN } from "../helpers.ts";
import { mockClient } from "../mock-client.ts";

const client = mockClient({
  answers: {
    [toFunctionSelector("eip712Domain()")]: encodeAbiParameters(
      [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
      ["0x0f", "USDC", "2", BigInt(CHAIN_ID), TOKEN, ZERO_HASH, []],
    ),
  },
});

// anvil default account 9 (public test key): the attacker's sybil payer. It needs to hold one base unit only.
const sybil = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
// anvil default account 8 (public test key): a throwaway "payee" for the cancel variant.
const throwaway = privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97");

const issue = async (signer: typeof payee, expiry: { kind: "never"; confirmed: true } | { kind: "at"; validUntil: bigint }, amount = 0n) => {
  const issued = await issueInvoice({
    registry,
    chainId: CHAIN_ID,
    draft: { payee: signer.address, token: TOKEN, amount, maxPayments: amount === 0n ? 0 : 1, validAfter: T0 - 60n, expiry },
    signer,
  });
  return decodeInvoiceFragment(issued.fragment, registry);
};

async function ruleOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return isPayLinkError(error, "E_INVALID_ARGUMENT") ? error.params["rule"] : String(error);
  }
  return "accepted";
}

describe("A-04: time-boundary relays and payee bans (regression)", () => {
  it("refuses a payer-chosen validBefore = now + 1 before any gas is spent", async () => {
    const card = await issue(payee, { kind: "never", confirmed: true });
    // The sybil signs a 1-second authorization: the margin check refuses it at chain time T0, so nothing is sent.
    const { request } = await authorizePayment({ outstanding: null, link: card, signer: sybil, now: T0, amount: 1n, ttlSeconds: 1n });
    expect(request.authorization.validBefore).toBe((T0 + 1n).toString());
    expect(await ruleOf(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(request), client, now: T0 }))).toBe("RelayValidityTooShort");
  });

  it("refuses a relay requested in the invoice's last seconds", async () => {
    const invoice = await issue(payee, { kind: "at", validUntil: T0 + 30n }, 25_000_000n);
    const { request } = await authorizePayment({ outstanding: null, link: invoice, signer: sybil, now: T0 });
    expect(await ruleOf(() => checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(request), client, now: T0 }))).toBe("RelayValidityTooShort");
  });

  it("refuses a cancellation whose deadline is the current second (no funds, no transaction needed)", async () => {
    const link = await issue(throwaway, { kind: "at", validUntil: T0 + 86_400n }, 25_000_000n);
    const cancel = await signCancel({ signer: throwaway, deployment: { chainId: CHAIN_ID, verifyingContract: CONTRACT }, invoice: link.invoice, deadline: T0 });
    expect(await ruleOf(() => checkRelayCancelRequest({ registry, pathChainId: CHAIN_ID, request: cancel, client, now: T0 }))).toBe("RelayValidityTooShort");
  });

  it("a payer-side revert bans the sybil payer, never the honest payee: the merchant's other links stay relayable", async () => {
    const card = await issue(payee, { kind: "never", confirmed: true });
    const invoice = await issue(payee, { kind: "at", validUntil: T0 + 7n * 86_400n }, 25_000_000n);
    const { request } = await authorizePayment({ outstanding: null, link: card, signer: sybil, now: T0, amount: 1n });
    const checked = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(request), client, now: T0 });
    const ledger = new RelayAdmissionLedger();
    const admission = ledger.admit(checked, requesterFromIp("203.0.113.7"), T0);
    if (!admission.admitted) {
      throw new Error(`refused: ${admission.reason}`);
    }
    // Whatever the sybil does after admission (spend its unit, cancel or reuse its nonce, delegate its EOA), the
    // evidence names the payer (attributeRelayRevert) and only the payer is banned.
    expect(ledger.release(admission.ticket, { cause: "payer", detail: "authorization-spent-elsewhere" }, T0 + 1n).banned).toEqual(["payer"]);
    const genuine = await authorizePayment({ outstanding: null, link: invoice, signer: payer, now: T0 + 2n });
    const honest = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(genuine.request), client, now: T0 + 2n });
    expect(ledger.admit(honest, requesterFromIp("198.51.100.20"), T0 + 2n).admitted).toBe(true);
    // The sybil itself is out for the day, from any requester.
    expect(ledger.admit({ ...checked, key: honest.key, payee: payer.address }, requesterFromIp("198.51.100.21"), T0 + 3n)).toMatchObject({ admitted: false, reason: "banned-payer" });
  });

  it("the same authorization landing first by another route bans nobody", async () => {
    const card = await issue(payee, { kind: "never", confirmed: true });
    const { request } = await authorizePayment({ outstanding: null, link: card, signer: payer, now: T0, amount: 25_000_000n });
    const checked = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(request), client, now: T0 });
    const ledger = new RelayAdmissionLedger();
    const admission = ledger.admit(checked, requesterFromIp("203.0.113.9"), T0);
    if (!admission.admitted) {
      throw new Error(`refused: ${admission.reason}`);
    }
    expect(ledger.release(admission.ticket, { cause: "superseded", detail: "authorization-settled-this-payment" }, T0 + 1n)).toEqual({ outcome: "superseded", banned: [], bannedUntil: null, struck: false });
    expect(ledger.activeBans(T0 + 1n).size).toBe(0);
  });
});
