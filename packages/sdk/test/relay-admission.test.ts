// SPDX-License-Identifier: MIT
/**
 * The relayer's admission policy (invoice spec §13.3; audit findings A-02, A-03 and A-04). Regression tests for the
 * griefing pattern "pass simulation, revert on inclusion, the relayer pays": one payee action (an ERC-1271 toggle, a
 * `cancel` of a receive card) or one payer action (an EIP-7702 delegation) must revert at most one paid relay; a
 * relay that reverts after its simulation passed must cost the party that caused it, and only that party (A-04:
 * a payer-side revert used to ban the honest payee for every link); and time bounds must keep a margin. The
 * on-chain mechanics are pinned by protocol/test/audit/A02_RelayerGriefing.t.sol, A04_TimeBoundaryBan.t.sol and by
 * the anvil suite.
 */
import { encodeAbiParameters, keccak256, toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import {
  authorizePayment,
  checkRelayCancelRequest,
  checkRelayPayRequest,
  DEFAULT_RELAY_ADMISSION_POLICY,
  decodeInvoiceFragment,
  isPayLinkError,
  issueInvoice,
  parseRelayPayRequest,
  RelayAdmissionLedger,
  requesterFromIp,
  REVERT_PENALTIES,
  signCancel,
  ZERO_HASH,
} from "../src/index.ts";
import type { Admission, CheckedPayRequest, CheckedRelayCall, RelayAdmissionSnapshot, RelayTicket, RevertCause } from "../src/index.ts";
import { CHAIN_ID, CONTRACT, payee, payer, registry, T0, TOKEN } from "./helpers.ts";
import { mockClient } from "./mock-client.ts";

const client = mockClient({
  answers: {
    [toFunctionSelector("eip712Domain()")]: encodeAbiParameters(
      [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }],
      ["0x0f", "USDC", "2", BigInt(CHAIN_ID), TOKEN, ZERO_HASH, []],
    ),
  },
});

const address = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const key = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
/** A requester per number: distinct IPv4 addresses. */
const ip = (n: number) => requesterFromIp(`198.51.100.${String(n)}`);
const reverted = (cause: RevertCause) => ({ cause, detail: "test" });

let pay: CheckedPayRequest;
let cancel: CheckedRelayCall;

beforeAll(async () => {
  const issued = await issueInvoice({
    registry,
    chainId: CHAIN_ID,
    draft: { payee: payee.address, token: TOKEN, amount: 0n, maxPayments: 0, validAfter: T0 - 60n, expiry: { kind: "never", confirmed: true } },
    signer: payee,
  });
  const link = decodeInvoiceFragment(issued.fragment, registry);
  const { request } = await authorizePayment({ outstanding: null, link, signer: payer, now: T0, amount: 1n });
  pay = await checkRelayPayRequest({ registry, pathChainId: CHAIN_ID, request: parseRelayPayRequest(request), client, now: T0 });
  const signed = await signCancel({ signer: payee, deployment: { chainId: CHAIN_ID, verifyingContract: CONTRACT }, invoice: link.invoice, deadline: T0 + 3600n });
  cancel = await checkRelayCancelRequest({ registry, pathChainId: CHAIN_ID, request: signed, client, now: T0 });
});

/**
 * Another relay request: a sybil payer, payee or card, as an attacker would multiply them. Valid for long enough
 * that the time margin never interferes with what a test is about.
 */
const variant = (overrides: { key?: number; payee?: number; payer?: number; token?: number }): CheckedPayRequest => ({
  ...pay,
  validThrough: T0 + 1_000_000n,
  ...(overrides.key === undefined ? {} : { key: key(overrides.key) }),
  ...(overrides.payee === undefined ? {} : { payee: address(overrides.payee) }),
  ...(overrides.payer === undefined ? {} : { payer: address(overrides.payer) }),
  ...(overrides.token === undefined ? {} : { token: { ...pay.token, address: address(overrides.token) } }),
});

/** The single ticket in flight. */
const only = (ledger: RelayAdmissionLedger): RelayTicket => {
  const [ticket, ...rest] = ledger.inFlight();
  if (ticket === undefined || rest.length > 0) {
    throw new Error("expected exactly one relay in flight");
  }
  return ticket;
};

const ticketOf = (admission: Admission): RelayTicket => {
  if (!admission.admitted) {
    throw new Error(`refused: ${admission.reason}`);
  }
  return admission.ticket;
};

const dimension = (kind: "key" | "payee" | "payer", value: string): string => `${kind}:${String(CHAIN_ID)}:${value.toLowerCase()}`;

describe("RelayAdmissionLedger: in-flight bounds", () => {
  it("admits the real request and records everything attribution needs", () => {
    const ledger = new RelayAdmissionLedger();
    expect(pay.payeeCode.kind).toBe("none");
    expect(cancel.payeeCode.kind).toBe("none");
    const ticket = ticketOf(ledger.admit(pay, requesterFromIp("203.0.113.7"), T0));
    expect(ticket).toEqual({
      id: "1",
      kind: "pay",
      chainId: CHAIN_ID,
      contract: CONTRACT,
      key: pay.key,
      payee: payee.address,
      payer: payer.address,
      token: TOKEN,
      requester: "ip4:203.0.113.7",
      admittedAt: T0,
      validThrough: T0 + 599n,
      payeeCodeHash: null,
      payerCodeHash: null,
      payment: { nonce: pay.nonce, amount: 1n, payerRef: ZERO_HASH },
    });
    expect(ledger.inFlight()).toEqual([ticket]);
    expect(ticketOf(new RelayAdmissionLedger().admit(cancel, ip(1), T0))).toMatchObject({ kind: "cancel", payer: null, payment: null, payerCodeHash: null, validThrough: T0 + 3600n });
  });

  it("lets one payee action revert at most one paid relay: a second relay for the same card or payee waits", () => {
    const ledger = new RelayAdmissionLedger();
    const first = ticketOf(ledger.admit(variant({ payer: 1 }), ip(1), T0));
    // Sybil payers for the same receive card (one `cancel` would revert them all): refused while one is in flight.
    expect(ledger.admit(variant({ payer: 2 }), ip(2), T0)).toEqual({ admitted: false, reason: "in-flight-key", retryAfter: null });
    // Another card of the same payee (one ERC-1271 toggle would revert them all): refused too.
    expect(ledger.admit(variant({ payer: 3, key: 99 }), ip(3), T0)).toEqual({ admitted: false, reason: "in-flight-payee", retryAfter: null });
    // The same payer elsewhere (one EIP-7702 delegation would revert them all): refused.
    expect(ledger.admit(variant({ payer: 1, key: 98, payee: 98 }), ip(1), T0)).toEqual({ admitted: false, reason: "in-flight-payer", retryAfter: null });
    // Once the first relay resolves, the next one goes.
    expect(ledger.release(first, "settled", T0 + 2n)).toEqual({ outcome: "settled", banned: [], bannedUntil: null, struck: false });
    expect(ledger.admit(variant({ payer: 2 }), ip(2), T0 + 2n).admitted).toBe(true);
  });

  it("caps the total per token, which sybil payees and payers cannot multiply", () => {
    const ledger = new RelayAdmissionLedger();
    for (let i = 1; i <= DEFAULT_RELAY_ADMISSION_POLICY.maxInFlightPerToken; i += 1) {
      expect(ledger.admit(variant({ key: i, payee: 100 + i, payer: 200 + i }), ip(i), T0).admitted).toBe(true);
    }
    expect(ledger.admit(variant({ key: 50, payee: 150, payer: 250 }), ip(50), T0)).toEqual({ admitted: false, reason: "in-flight-token", retryAfter: null });
    expect(ledger.admit(variant({ key: 51, payee: 151, payer: 251, token: 7 }), ip(51), T0).admitted).toBe(true);
    expect(ledger.inFlight()).toHaveLength(5);
    // Releasing one of the four frees exactly one token slot.
    const [first] = ledger.inFlight();
    if (first === undefined) {
      throw new Error("expected relays in flight");
    }
    ledger.release(first, "settled", T0 + 1n);
    expect(ledger.admit(variant({ key: 52, payee: 152, payer: 252 }), ip(52), T0 + 1n).admitted).toBe(true);
    expect(ledger.admit(variant({ key: 53, payee: 153, payer: 253 }), ip(53), T0 + 1n)).toMatchObject({ admitted: false, reason: "in-flight-token" });
  });

  it("bounds cancellations by key and payee as well (a toggling payee can revert a relayed cancelBySig too)", () => {
    const ledger = new RelayAdmissionLedger();
    const ticket = ticketOf(ledger.admit(cancel, ip(1), T0));
    expect(ledger.admit(cancel, ip(2), T0)).toMatchObject({ admitted: false, reason: "in-flight-key" });
    expect(ledger.admit(pay, ip(2), T0)).toMatchObject({ admitted: false, reason: "in-flight-key" });
    ledger.release(ticket, "dropped", T0);
    expect(ledger.admit(pay, ip(2), T0).admitted).toBe(true);
  });
});

describe("RelayAdmissionLedger: time margin (A-04)", () => {
  it("refuses, on the relayer's clock too, a request whose time bounds end within the chain's margin", () => {
    // checkRelayPayRequest applied the margin at chain time T0; a request admitted later must still have it.
    const ledger = new RelayAdmissionLedger();
    const lastAdmissible = pay.validThrough - pay.minRemainingSeconds;
    expect(ledger.admit(pay, ip(1), lastAdmissible + 1n)).toEqual({ admitted: false, reason: "insufficient-validity", retryAfter: null });
    expect(ledger.admit(cancel, ip(1), cancel.validThrough - cancel.minRemainingSeconds + 1n)).toMatchObject({ admitted: false, reason: "insufficient-validity" });
    expect(ledger.inFlight()).toHaveLength(0);
    expect(ledger.admit(pay, ip(1), lastAdmissible).admitted).toBe(true);
  });
});

describe("RelayAdmissionLedger: penalties follow the cause (A-04)", () => {
  it("bans nobody for a settled, dropped, superseded, late or token-side relay", () => {
    for (const outcome of ["settled", "dropped", reverted("superseded"), reverted("late-inclusion"), reverted("token")] as const) {
      const ledger = new RelayAdmissionLedger();
      const released = ledger.release(ticketOf(ledger.admit(pay, ip(1), T0)), outcome, T0 + 1n);
      expect(released).toEqual({ outcome: typeof outcome === "string" ? outcome : outcome.cause, banned: [], bannedUntil: null, struck: false });
      expect(ledger.activeBans(T0 + 1n).size).toBe(0);
      expect(ledger.admit(pay, ip(2), T0 + 1n).admitted).toBe(true);
    }
  });

  it("a payer-side revert bans the payer only: the honest payee's other links and the card stay relayable", () => {
    const ledger = new RelayAdmissionLedger();
    const released = ledger.release(ticketOf(ledger.admit(pay, ip(1), T0)), reverted("payer"), T0 + 1n);
    const until = T0 + 1n + 86_400n;
    expect(released).toEqual({ outcome: "payer", banned: ["payer"], bannedUntil: until, struck: true });
    expect([...ledger.activeBans(T0 + 1n).keys()]).toEqual([dimension("payer", payer.address)]);
    expect(ledger.admit(variant({ key: 2, payee: 2 }), ip(2), T0 + 2n)).toEqual({ admitted: false, reason: "banned-payer", retryAfter: until });
    // Another customer paying the same card, and the payee's other invoices: admitted.
    expect(ticketOf(ledger.admit(variant({ payer: 5 }), ip(2), T0 + 2n)).payee).toBe(payee.address);
  });

  it("a payee-side revert bans the key and the payee, a sold-out race the key only", () => {
    const ledger = new RelayAdmissionLedger();
    const byPayee = ledger.release(ticketOf(ledger.admit(pay, ip(1), T0)), reverted("payee"), T0 + 5n);
    const until = T0 + 5n + 86_400n;
    expect(byPayee).toEqual({ outcome: "payee", banned: ["key", "payee"], bannedUntil: until, struck: true });
    expect(ledger.admit(pay, ip(2), T0 + 6n)).toEqual({ admitted: false, reason: "banned-key", retryAfter: until });
    expect(ledger.admit(variant({ key: 2 }), ip(2), T0 + 6n)).toEqual({ admitted: false, reason: "banned-payee", retryAfter: until });
    expect(ledger.admit(variant({ key: 2, payee: 2 }), ip(2), T0 + 6n).admitted).toBe(true);
    // Bans end on time: the card itself is relayable again from `until`.
    expect(ledger.admit(variant({ payee: 3, payer: 3 }), ip(3), until - 1n)).toMatchObject({ admitted: false, reason: "banned-key" });
    expect(ledger.admit(variant({ payee: 3, payer: 3 }), ip(3), until).admitted).toBe(true);
    expect(ledger.activeBans(until).size).toBe(0);

    const race = new RelayAdmissionLedger();
    expect(race.release(ticketOf(race.admit(pay, ip(1), T0)), reverted("sold-out"), T0)).toEqual({ outcome: "sold-out", banned: ["key"], bannedUntil: T0 + 86_400n, struck: false });
    expect(race.admit(variant({ key: 2 }), ip(1), T0).admitted).toBe(true);
  });

  it("an unattributed revert bans the key and only the parties with code", () => {
    const ledger = new RelayAdmissionLedger();
    expect(ledger.release(ticketOf(ledger.admit(pay, ip(1), T0)), reverted("unattributed"), T0)).toEqual({ outcome: "unattributed", banned: ["key"], bannedUntil: T0 + 86_400n, struck: true });
    const wallet: Hex = "0x6080604052";
    const permissive = new RelayAdmissionLedger({ relayPayersWithCode: true, payeeCodeHashAllowlist: [keccak256(wallet)] });
    const withCode: CheckedPayRequest = { ...pay, payeeCode: { kind: "contract", codeHash: keccak256(wallet) }, payerCode: { kind: "delegated", codeHash: keccak256("0xef0100") } };
    const ticket = ticketOf(permissive.admit(withCode, ip(1), T0));
    expect([ticket.payeeCodeHash, ticket.payerCodeHash]).toEqual([keccak256(wallet), keccak256("0xef0100")]);
    expect(permissive.release(ticket, reverted("unattributed"), T0).banned).toEqual(["key", "payee", "payer"]);
  });

  it("matches the normative penalty table", () => {
    expect(REVERT_PENALTIES).toEqual({
      superseded: { ban: [], banIfCode: [], strike: false },
      "late-inclusion": { ban: [], banIfCode: [], strike: false },
      payer: { ban: ["payer"], banIfCode: [], strike: true },
      payee: { ban: ["key", "payee"], banIfCode: [], strike: true },
      "sold-out": { ban: ["key"], banIfCode: [], strike: false },
      token: { ban: [], banIfCode: [], strike: false },
      unattributed: { ban: ["key"], banIfCode: ["payee", "payer"], strike: true },
    });
  });

  it("a cancellation has no payer to ban", () => {
    const ledger = new RelayAdmissionLedger();
    expect(ledger.release(ticketOf(ledger.admit(cancel, ip(3), T0)), reverted("payer"), T0)).toEqual({ outcome: "payer", banned: [], bannedUntil: null, struck: true });
    expect(ledger.release(ticketOf(ledger.admit(cancel, ip(3), T0)), reverted("payee"), T0).banned).toEqual(["key", "payee"]);
  });
});

describe("RelayAdmissionLedger: requesters", () => {
  it("bans a requester after three strikes within the ban window, counting an IPv6 /64 as one requester", () => {
    const ledger = new RelayAdmissionLedger();
    const hosts = ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:ffff:ffff:ffff:ffff"];
    hosts.forEach((host, i) => {
      const at = T0 + BigInt(i);
      expect(ledger.admit(variant({ key: i, payee: i, payer: i }), requesterFromIp(host), at).admitted).toBe(true);
      const released = ledger.release(only(ledger), reverted("payer"), at);
      expect(released.banned).toEqual(i === 2 ? ["payer", "requester"] : ["payer"]);
    });
    expect(ledger.admit(variant({ key: 9, payee: 9, payer: 9 }), requesterFromIp("2001:db8:1:2:abcd::9"), T0 + 10n)).toEqual({ admitted: false, reason: "banned-requester", retryAfter: T0 + 2n + 86_400n });
    // The neighbouring /64 is another requester.
    expect(ledger.admit(variant({ key: 9, payee: 9, payer: 9 }), requesterFromIp("2001:db8:1:3::1"), T0 + 10n).admitted).toBe(true);
    // Strikes older than the window do not accumulate.
    const slow = new RelayAdmissionLedger({ maxRequesterStrikes: 2, banSeconds: 100 });
    for (const [i, at] of [[1, T0], [2, T0 + 100n]] as const) {
      slow.admit(variant({ key: i, payee: i, payer: i }), ip(1), at);
      slow.release(only(slow), reverted("unattributed"), at);
    }
    expect(slow.admit(variant({ key: 3, payee: 3, payer: 3 }), ip(1), T0 + 101n).admitted).toBe(true);
  });

  it("rate-limits relays per requester, successful ones included, and gives back a dropped relay", () => {
    const ledger = new RelayAdmissionLedger({ maxRelaysPerRequester: 2, requesterWindowSeconds: 3600 });
    const relayOnce = (n: number, at: bigint, outcome: "settled" | "dropped") => {
      ledger.release(ticketOf(ledger.admit(variant({ key: n, payee: n, payer: n }), ip(1), at)), outcome, at);
    };
    relayOnce(1, T0, "settled");
    relayOnce(2, T0 + 1n, "dropped"); // no gas spent: given back
    relayOnce(3, T0 + 2n, "settled");
    expect(ledger.admit(variant({ key: 4, payee: 4, payer: 4 }), ip(1), T0 + 3n)).toEqual({ admitted: false, reason: "requester-rate-limit", retryAfter: T0 + 3600n });
    expect(ledger.admit(variant({ key: 4, payee: 4, payer: 4 }), ip(2), T0 + 3n).admitted).toBe(true);
    // The window ends: a fresh one starts.
    relayOnce(5, T0 + 3600n, "settled");
    relayOnce(6, T0 + 3601n, "settled");
    expect(ledger.admit(variant({ key: 7, payee: 7, payer: 7 }), ip(1), T0 + 3602n)).toMatchObject({ admitted: false, reason: "requester-rate-limit", retryAfter: T0 + 7200n });
  });

  it("does not give back a dropped relay counted in a window that has since ended", () => {
    const ledger = new RelayAdmissionLedger({ maxRelaysPerRequester: 1, requesterWindowSeconds: 10 });
    const old = ticketOf(ledger.admit(variant({ key: 1, payee: 1, payer: 1 }), ip(1), T0));
    ledger.release(ticketOf(ledger.admit(variant({ key: 2, payee: 2, payer: 2 }), ip(1), T0 + 10n)), "settled", T0 + 10n);
    ledger.release(old, "dropped", T0 + 11n);
    expect(ledger.admit(variant({ key: 3, payee: 3, payer: 3 }), ip(1), T0 + 12n)).toMatchObject({ admitted: false, reason: "requester-rate-limit" });
  });
});

describe("RelayAdmissionLedger: persistence and configuration", () => {
  it("survives a Durable Object restart through its snapshot", () => {
    const ledger = new RelayAdmissionLedger();
    const inFlight = ticketOf(ledger.admit(variant({ key: 1, payee: 1, payer: 1 }), ip(1), T0));
    const griefed = ticketOf(ledger.admit(variant({ key: 2, payee: 2, payer: 2 }), ip(2), T0));
    ledger.release(griefed, reverted("payee"), T0);
    const cancelling = ticketOf(ledger.admit({ ...cancel, key: key(4), payee: address(4) }, ip(4), T0));
    const snapshot = JSON.parse(JSON.stringify(ledger.snapshot())) as RelayAdmissionSnapshot;
    expect(snapshot.version).toBe(2);
    const restored = new RelayAdmissionLedger({}, snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.inFlight()).toEqual([inFlight, cancelling]);
    expect(restored.admit(variant({ key: 1, payee: 5, payer: 5 }), ip(3), T0)).toMatchObject({ admitted: false, reason: "in-flight-key" });
    expect(restored.admit(variant({ key: 2, payee: 6, payer: 6 }), ip(3), T0)).toMatchObject({ admitted: false, reason: "banned-key" });
    restored.release(inFlight, "settled", T0);
    expect(ticketOf(restored.admit(variant({ key: 3, payee: 3, payer: 3 }), ip(3), T0)).id).toBe("4");
    expect(() => {
      restored.release(inFlight, "settled", T0);
    }).toThrow(/not in flight/);
  });

  it("refuses an unusable policy and a snapshot of another version", () => {
    for (const policy of [{ maxInFlightPerKey: 0 }, { maxInFlightPerToken: 1.5 }, { banSeconds: 0 }, { maxRequesterStrikes: -1 }, { maxRelaysPerRequester: 0 }, { requesterWindowSeconds: 0.5 }]) {
      let caught: unknown;
      try {
        new RelayAdmissionLedger(policy);
      } catch (error) {
        caught = error;
      }
      expect(isPayLinkError(caught, "E_INVALID_ARGUMENT")).toBe(true);
    }
    const v1 = { version: 1, nextId: 1, inFlight: [], bans: {}, strikes: {} } as unknown as RelayAdmissionSnapshot;
    expect(() => new RelayAdmissionLedger({}, v1)).toThrow(/snapshot version/);
  });
});

describe("RelayAdmissionLedger: code policy", () => {
  const withCode = (who: "payee" | "payer", kind: "contract" | "delegated", code: Hex): CheckedPayRequest => ({
    ...pay,
    [who === "payee" ? "payeeCode" : "payerCode"]: { kind, codeHash: keccak256(code) },
  });

  it("relays a payee with code only when its code hash is allowlisted", () => {
    const wallet: Hex = "0x6080604052";
    expect(new RelayAdmissionLedger().admit(withCode("payee", "contract", wallet), ip(1), T0)).toEqual({ admitted: false, reason: "payee-code-not-allowlisted", retryAfter: null });
    const allowing = new RelayAdmissionLedger({ payeeCodeHashAllowlist: [keccak256(wallet).toUpperCase().replace("0X", "0x") as Hex] });
    expect(allowing.admit(withCode("payee", "contract", wallet), ip(1), T0).admitted).toBe(true);
    const delegatedPayee = { ...withCode("payee", "delegated", `0xef0100${"aa".repeat(20)}`), payeeCode: { kind: "delegated" as const, codeHash: null } };
    expect(allowing.admit(delegatedPayee, ip(1), T0)).toMatchObject({ admitted: false, reason: "payee-code-not-allowlisted" });
  });

  it("does not relay for payers with code (smart accounts, EIP-7702 delegated EOAs) unless configured to", () => {
    const delegated = withCode("payer", "delegated", `0xef0100${"bb".repeat(20)}`);
    expect(new RelayAdmissionLedger().admit(delegated, ip(1), T0)).toEqual({ admitted: false, reason: "payer-has-code", retryAfter: null });
    const permissive = new RelayAdmissionLedger({ relayPayersWithCode: true });
    expect(permissive.admit(delegated, ip(1), T0).admitted).toBe(true);
    // Still bounded and banned like any payer.
    expect(permissive.admit({ ...delegated, key: key(77), payee: address(77) }, ip(1), T0)).toMatchObject({ admitted: false, reason: "in-flight-payer" });
  });
});
