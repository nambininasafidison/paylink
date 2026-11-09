// SPDX-License-Identifier: MIT
/**
 * "Was I really paid?" (editions/mezo/verify.ts): what code
 * extracts from a message, and the verdict a fake Mezo testnet gives: paid only when a `Paid` event of the registry's
 * PayLinkV2 names the merchant; not received for a made-up hash, someone else's payment, an unpaid or cancelled
 * invoice, a failed transaction, an old receipt sent again for a new invoice or a forged receipt; pending for a
 * transaction outside a block; unknown when the chain does not answer or the message names nothing checkable.
 * The paste helper on the create terminal has its own file (paste.test.ts).
 */
import { encodeInvoiceFragment, encodeReceiptFragment, hashMemo, invoiceKey, PAID_TOPIC, payLinkV2Abi } from "@paylink/sdk";
import type { Invoice, SignedInvoice } from "@paylink/sdk";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, pad, TransactionReceiptNotFoundError, zeroAddress, zeroHash } from "viem";
import type { Token } from "@paylink/chains";
import type { Address, Hex, RpcLog, TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { appRegistry } from "../../src/core/registry.ts";
import { checkPayment, claimedAmounts, decimalOf, extract } from "../../src/editions/mezo/verify.ts";
import type { CheckClient, CheckContext } from "../../src/editions/mezo/verify.ts";

const MEZO = 31611;
const registry = appRegistry("mezo");
const chain = registry.getOrThrow(MEZO);
const target = registry.v2Target(MEZO);
const MUSD = getAddress("0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503");
const ME = getAddress("0x1111111111111111111111111111111111111111");
const SOMEONE = getAddress("0x2222222222222222222222222222222222222222");
const PAYER = getAddress("0x3333333333333333333333333333333333333333");
const units = (n: string): bigint => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;
const hash = (n: number): Hex => pad(`0x${n.toString(16)}`, { size: 32 });

function deployed(): NonNullable<typeof target> {
  if (target === undefined) {
    throw new Error("Mezo testnet has no deployment in the registry");
  }
  return target;
}
const musdToken = (): Token => {
  const token = registry.findToken(MEZO, MUSD);
  if (token === undefined) {
    throw new Error("MUSD is not on the registry's allowlist");
  }
  return token;
};

function link(payee: Address, amount: bigint, memo: string, salt: number) {
  const invoice: Invoice = { payee, token: MUSD, amount, validAfter: 0n, validUntil: 0n, maxPayments: 1, salt: hash(1000 + salt), memoHash: hashMemo(memo === "" ? null : memo) };
  const signed: SignedInvoice = { chainId: MEZO, invoice, signature: `0x${"11".repeat(65)}`, memo: memo === "" ? null : memo };
  const key = invoiceKey({ chainId: MEZO, verifyingContract: deployed().deployment.address }, invoice);
  return { signed, key, decoded: { ...signed, key, target: deployed(), token: musdToken() }, url: `https://mezo.paylink-mg.pages.dev/mezo/pay/#${encodeInvoiceFragment(signed)}`, fragment: encodeInvoiceFragment(signed) };
}

function paidLog(key: Hex, payee: Address, amount: bigint, logIndex: number, contract: Address = target?.deployment.address ?? zeroAddress) {
  return {
    address: contract,
    topics: [PAID_TOPIC, key, pad(payee), pad(PAYER)] as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }], [MUSD, amount, 0, zeroHash]),
    logIndex,
    blockNumber: 500n,
    transactionHash: zeroHash,
  };
}

interface FakeChain {
  receipts: Map<Hex, { status: "success" | "reverted"; logs: ReturnType<typeof paidLog>[] }>;
  pending: Set<Hex>;
  states: Map<Hex, { payments: number; cancelled: boolean; lastPaidAt: bigint; total: bigint }>;
  down: boolean;
}

function fakeClient(world: FakeChain): CheckClient {
  const blockTime = (n: bigint): bigint => 1_800_000_000n + n * 2n;
  const answer = <T>(value: () => T): Promise<T> => (world.down ? Promise.reject(new Error("HTTP request failed")) : Promise.resolve().then(value));
  return {
    chain,
    call: ({ data }) =>
      answer(() => {
        const { args } = decodeFunctionData({ abi: payLinkV2Abi, data });
        const key = (args as readonly Hex[])[0] ?? zeroHash;
        const state = world.states.get(key) ?? { payments: 0, cancelled: false, lastPaidAt: 0n, total: 0n };
        return { data: encodeFunctionResult({ abi: payLinkV2Abi, functionName: "stateOf", result: state }) };
      }),
    getBlock: (p) =>
      answer(() => {
        const number = "blockNumber" in p ? p.blockNumber : 1_000n;
        return { number, timestamp: blockTime(number) };
      }),
    getBlockNumber: () => answer(() => 1_000n),
    getLogs: (filter) =>
      answer(() => {
        const out: RpcLog[] = [];
        for (const [tx, receipt] of world.receipts) {
          for (const log of receipt.logs) {
            if (log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock && log.topics[1] === filter.topics[1]) {
              out.push({ ...log, blockNumber: `0x${log.blockNumber.toString(16)}`, logIndex: `0x${log.logIndex.toString(16)}`, transactionHash: tx, blockHash: zeroHash, transactionIndex: "0x0", removed: false } as unknown as RpcLog);
            }
          }
        }
        return out;
      }),
    getTransactionReceipt: ({ hash: h }) =>
      answer(() => {
        const receipt = world.receipts.get(h);
        if (receipt === undefined) {
          throw new TransactionReceiptNotFoundError({ hash: h });
        }
        return { status: receipt.status, blockNumber: 500n, logs: receipt.logs } as unknown as TransactionReceipt;
      }),
    getTransaction: (h) => answer(() => (world.pending.has(h) ? { blockNumber: null } : world.receipts.has(h) ? { blockNumber: 500n } : null)),
  };
}

function context(world: FakeChain, invoices: CheckContext["invoices"] = []): CheckContext {
  return { registry, chainId: MEZO, client: fakeClient(world), merchant: ME, invoices, host: "mezo.paylink-mg.pages.dev" };
}
const emptyWorld = (): FakeChain => ({ receipts: new Map(), pending: new Set(), states: new Map(), down: false });

describe("what a message names (extract)", () => {
  it("reads amounts as people type them, in MUSD, dollars, BTC and sats, and nothing without a unit", () => {
    expect(decimalOf("1,250.50")).toBe("1250.5");
    expect(decimalOf("1 250,50")).toBe("1250.5");
    expect(decimalOf("12,50")).toBe("12.5");
    expect(decimalOf("1,250")).toBe("1250");
    expect(decimalOf("007")).toBe("7");
    const found = claimedAmounts("Paid 12.50 MUSD, plus $1,250.50 and USD 30; 0.001 BTC and 50,000 sats; 1 250,5 MUSD; ref 31611 and 42.");
    expect(found.map((a) => `${a.value} ${a.unit}`)).toEqual(["12.5 MUSD", "1250.5 USD", "30 USD", "0.001 BTC", "0.0005 BTC", "1250.5 MUSD"]);
    expect(found[0]?.base).toBe(units("12.5"));
    expect(claimedAmounts("I sent it at 12:30, invoice 7")).toEqual([]);
  });

  it("separates PayLink links (invoice, till, receipt) from hashes, and keeps an explorer link's hash", () => {
    const tx = hash(7);
    const one = link(ME, units("12.5"), "Logo", 1);
    const text = `Done! ${one.url}. Receipt: https://evil.example/r/#2.31611.${tx}.0 and https://explorer.test.mezo.org/tx/${hash(8)} ${tx.toUpperCase().replace("0X", "0x")}`;
    const found = extract(text);
    expect(found.links.map((l) => [l.kind, l.host])).toEqual([
      ["invoice", "mezo.paylink-mg.pages.dev"],
      ["receipt", "evil.example"],
    ]);
    expect(found.hashes).toEqual([tx, hash(8)]);
    expect(extract(one.url.replace("/pay/", "/till/")).links[0]?.kind).toBe("invoice");
  });
});

describe("the verdict comes from the chain alone (checkPayment)", () => {
  it("Mezo testnet has a PayLinkV2 deployment in the registry", () => {
    expect(target?.deployment.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("paid: a transaction whose Paid event names this merchant, with amount, token, block and time; a claimed amount that differs is flagged", async () => {
    const one = link(ME, units("12.5"), "Logo design", 1);
    const world = emptyWorld();
    world.receipts.set(hash(1), { status: "success", logs: [paidLog(one.key, ME, units("12.5"), 3)] });
    const result = await checkPayment(`I paid 12.50 MUSD, tx ${hash(1)}`, context(world, [one.decoded]));
    expect(result.verdict).toBe("paid");
    expect(result.amountMismatch).toBe(false);
    const paid = result.findings[0];
    expect(paid).toMatchObject({ kind: "paid", source: "transaction", key: one.key, amount: units("12.5"), txHash: hash(1), blockNumber: 500n, timestamp: 1_800_001_000n, payer: PAYER, memo: "Logo design" });
    expect(paid?.kind === "paid" ? paid.token.symbol : null).toBe("MUSD");
    const claimedMore = await checkPayment(`Sent you 20 MUSD: ${hash(1)}`, context(world));
    expect([claimedMore.verdict, claimedMore.amountMismatch]).toEqual(["paid", true]);
  });

  it("not received: a made-up hash, someone else's payment, a failed transaction, a transaction that is no PayLink payment", async () => {
    const world = emptyWorld();
    const theirs = link(SOMEONE, units("5"), "", 2);
    world.receipts.set(hash(2), { status: "success", logs: [paidLog(theirs.key, SOMEONE, units("5"), 0)] });
    world.receipts.set(hash(3), { status: "reverted", logs: [] });
    world.receipts.set(hash(4), { status: "success", logs: [paidLog(theirs.key, ME, units("5"), 0, MUSD)] });
    for (const [n, kind] of [[9, "no-tx"], [2, "other-payee"], [3, "reverted"], [4, "not-paylink"]] as const) {
      const result = await checkPayment(`payment proof: ${hash(n)}`, context(world));
      expect([result.verdict, result.findings[0]?.kind]).toEqual(["not-received", kind]);
    }
  });

  it("pending outside a block; unknown when the chain does not answer, or when the message names nothing checkable", async () => {
    const world = emptyWorld();
    world.pending.add(hash(5));
    expect((await checkPayment(hash(5), context(world))).verdict).toBe("pending");
    expect(await checkPayment("I paid you yesterday, trust me", context(world))).toMatchObject({ verdict: "unknown", reason: "nothing" });
    world.down = true;
    expect(await checkPayment(hash(6), context(world))).toMatchObject({ verdict: "unknown", reason: "unavailable" });
  });

  it("an invoice link: unpaid, cancelled, someone else's, or paid with its last payment's block found by its time", async () => {
    const world = emptyWorld();
    const mine = link(ME, units("12.5"), "Logo design", 3);
    expect((await checkPayment(mine.url, context(world))).findings[0]).toMatchObject({ kind: "unpaid", cancelled: false, memo: "Logo design" });
    world.states.set(mine.key, { payments: 0, cancelled: true, lastPaidAt: 0n, total: 0n });
    expect((await checkPayment(mine.url, context(world))).findings[0]).toMatchObject({ kind: "unpaid", cancelled: true });
    const theirs = link(SOMEONE, units("12.5"), "", 4);
    expect(await checkPayment(theirs.url, context(world))).toMatchObject({ verdict: "not-received", findings: [{ kind: "other-payee", source: "invoice" }] });
    world.receipts.set(hash(10), { status: "success", logs: [paidLog(mine.key, ME, units("12.5"), 1)] });
    world.states.set(mine.key, { payments: 1, cancelled: false, lastPaidAt: 1_800_001_000n, total: units("12.5") });
    const paid = await checkPayment(`see ${mine.url}`, context(world));
    expect(paid.verdict).toBe("paid");
    expect(paid.findings[0]).toMatchObject({ kind: "paid", source: "invoice", amount: units("12.5"), txHash: hash(10), blockNumber: 500n, payer: PAYER });
    // A bare invoice key of this device's invoice counts as that invoice; an amount alone finds it too.
    const own = [mine.decoded];
    expect((await checkPayment(mine.key, context(world, own))).findings[0]).toMatchObject({ kind: "paid", source: "invoice" });
    expect((await checkPayment("I sent 12,50 MUSD", context(world, own))).findings[0]).toMatchObject({ kind: "paid", source: "amount" });
  });

  it("an old receipt sent again for a new invoice is not that invoice's payment", async () => {
    const world = emptyWorld();
    const old = link(ME, units("12.5"), "September", 5);
    const fresh = link(ME, units("12.5"), "October", 6);
    world.receipts.set(hash(11), { status: "success", logs: [paidLog(old.key, ME, units("12.5"), 0)] });
    const result = await checkPayment(`Paid! ${fresh.url} tx ${hash(11)}`, context(world));
    expect(result.verdict).toBe("not-received");
    expect(result.findings.map((f) => f.kind).sort()).toEqual(["other-invoice", "unpaid"]);
    // The same with the old invoice's receipt link: what it proves is the old invoice's payment.
    const oldReceipt = `https://mezo.paylink-mg.pages.dev/mezo/r/#${encodeReceiptFragment({ chainId: MEZO, txHash: hash(11), logIndex: 0 }, old.signed)}`;
    expect((await checkPayment(`${fresh.url} ${oldReceipt}`, context(world))).verdict).toBe("not-received");
    expect((await checkPayment(oldReceipt, context(world))).verdict).toBe("paid");
  });

  it("a receipt link is re-verified: a forged one proves nothing, a genuine one to this merchant is paid; a link off this site is flagged", async () => {
    const world = emptyWorld();
    const mine = link(ME, units("12.5"), "Logo", 7);
    world.receipts.set(hash(12), { status: "success", logs: [paidLog(mine.key, ME, units("12.5"), 2)] });
    const genuine = `https://mezo.paylink-mg.pages.dev/mezo/r/#${encodeReceiptFragment({ chainId: MEZO, txHash: hash(12), logIndex: 2 }, mine.signed)}`;
    expect(await checkPayment(genuine, context(world))).toMatchObject({ verdict: "paid", foreignHosts: [], findings: [{ kind: "paid", source: "receipt", memo: "Logo" }] });
    const forged = `https://paylink-mezo.example/r/#${encodeReceiptFragment({ chainId: MEZO, txHash: hash(12), logIndex: 7 })}`;
    expect(await checkPayment(forged, context(world))).toMatchObject({ verdict: "not-received", foreignHosts: ["paylink-mezo.example"], findings: [{ kind: "forged" }] });
    expect(await checkPayment("https://mezo.paylink-mg.pages.dev/mezo/pay/#2.31611.garbage", context(world))).toMatchObject({ verdict: "unknown", reason: "nothing", findings: [{ kind: "bad-link" }] });
  });
});
