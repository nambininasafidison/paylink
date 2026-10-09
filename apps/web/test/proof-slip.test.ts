// SPDX-License-Identifier: MIT
/**
 * The verified receipt slip (app/proof-slip.ts), shared by the pay view and /r/:
 * - payee and payer in full, grouped by four (a 4 + 4 hex prefix and suffix is 32 bits, which an address grinder
 *   matches: THREAT_MODEL T-43, invoice spec §12 and §14.4);
 * - whose address the payee is, from this device's own records: the account signed in here, a saved contact, the
 *   payer's own payment, or an amber "not paid to you", including for a look-alike of the account's address;
 * - on paper, what re-proves it: the full transaction hash, the CAIP-2 id, the log index and the receipt link with its
 *   QR code; on screen the short transaction with its explorer link.
 */
import { createTranslator, EN } from "@paylink/i18n";
import type { ReceiptProof } from "@paylink/sdk";
import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { AccountProvider } from "../src/accounts/types.ts";
import type { App } from "../src/app/context.ts";
import { payeeIdentity, proofSlip } from "../src/app/proof-slip.ts";
import { drawSlipQr } from "../src/pages/receipt.ts";
import type { PayeeIdentity } from "../src/app/proof-slip.ts";
import type { ContactRecord } from "../src/store/db.ts";
import { qrMatrix, qrPath } from "../src/ui/qr.ts";
import { CONTRACT, localChain, token, TOKEN_ADDRESS } from "./helpers.ts";

const PAYEE: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** Shares the first four and the last four hex digits with PAYEE: what a vanity grinder produces in minutes. */
const LOOK_ALIKE: Address = getAddress("0x7099a3b04b1e2f6c9d3e7af0c1b2d4e5f6a779c8");
const PAYER: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const TX: Hex = "0x8d8e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4847a";
const URL_ = "https://paylink-mg.pages.dev/monad/r/#2.10143.0x8d8e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4847a.3";

const proof = (payee: Address = PAYEE): ReceiptProof => ({
  contract: CONTRACT,
  key: `0x${"ab".repeat(32)}`,
  payee,
  payer: PAYER,
  token: TOKEN_ADDRESS,
  amount: 25_000_000n,
  index: 0,
  payerRef: `0x${"00".repeat(32)}`,
  chainId: 31337,
  txHash: TX,
  logIndex: 3,
  tokenInfo: token,
  blockNumber: 101n,
  timestamp: 1_791_417_600n,
  finality: "confirmed",
  invoice: null,
  memo: "Invoice #42",
});

function app(account: { address: Address; kind: AccountProvider["kind"] } | null, contacts: readonly ContactRecord[] = []): App {
  return {
    i18n: createTranslator("en", EN, { fallback: EN }),
    locale: "en",
    session: { ready: Promise.resolve(), account: () => account },
    store: { listContacts: () => Promise.resolve(contacts) },
  } as unknown as App;
}

const contact = (address: Address, label: string): ContactRecord => ({ address, label, card: null, updatedAt: 1 });

function render(identity: PayeeIdentity, payee: Address = PAYEE): HTMLElement {
  return proofSlip(app(null), { proof: proof(payee), chain: localChain(), url: URL_, identity, checks: [["ok", "Payment found"]] });
}

const groups = (element: Element | null | undefined): string => [...(element?.querySelectorAll(".addr > span[aria-hidden]") ?? [])].map((g) => g.textContent).join(" ");
const rowOf = (slip: HTMLElement, term: string, only?: "screen" | "print"): HTMLElement | undefined =>
  [...slip.querySelectorAll<HTMLElement>(".receipt dl > div")].find((row) => row.querySelector("dt")?.textContent === term && (only === undefined ? !row.className.startsWith("only-") : row.classList.contains(`only-${only}`)));

describe("the receipt slip", () => {
  it("names payee and payer in full, grouped by four, never 0x7099…79C8", () => {
    const slip = render({ kind: "unknown" });
    expect(groups(rowOf(slip, "To"))).toBe("0x7099 7970 C518 12dc 3A01 0C7d 01b5 0e0d 17dc 79C8");
    expect(groups(rowOf(slip, "From"))).toBe("0x90F7 9bf6 EB2c 4f87 0365 E785 982E 1f10 1E93 b906");
    expect(rowOf(slip, "To")?.querySelector(".addr")?.getAttribute("title")).toBe(PAYEE);
    expect(slip.querySelector(".receipt dl")?.textContent).not.toContain("…79C8");
    expect(rowOf(slip, "For")?.querySelector("dd")?.textContent).toBe("Invoice #42");
  });

  it("keeps the transaction short on screen and prints what re-proves it: full hash, CAIP-2, log index, link and QR", async () => {
    const slip = render({ kind: "unknown" });
    expect(rowOf(slip, "Tx", "screen")?.querySelector("dd")?.textContent).toBe("0x8d8e…847a");
    const printed = rowOf(slip, "Tx", "print")?.querySelector(".hex");
    expect(printed?.textContent).toBe(TX);
    expect(printed?.getAttribute("title")).toBe(TX);
    expect(rowOf(slip, "Chain ID", "print")?.querySelector("dd")?.textContent).toBe("eip155:31337");
    expect(rowOf(slip, "Log index", "print")?.querySelector("dd")?.textContent).toBe("3");
    const verify = slip.querySelector(".receipt-verify.only-print");
    expect(verify?.querySelector(".printed-url")?.textContent).toBe(URL_.replace("https://", ""));
    // The QR code is drawn for paper (its library stays off the pay route), once, from the receipt link.
    expect(verify?.querySelector(".qr")).toBeNull();
    await drawSlipQr(app(null), slip);
    await drawSlipQr(app(null), slip);
    expect(verify?.querySelectorAll(".qr")).toHaveLength(1);
    expect(verify?.querySelector(".qr")?.getAttribute("aria-label")).toBe("QR code of the receipt link");
    expect(verify?.querySelector(".qr path")?.getAttribute("d")).toBe(qrPath(qrMatrix(URL_)));
    // Whose address it is belongs to this screen, not to the paper.
    expect(slip.querySelector(".receipt-who")?.classList.contains("only-screen")).toBe(true);
  });

  it("says whose address the payee is: green when this device knows it, amber when it is not the account here", () => {
    const line = (identity: PayeeIdentity): [string | null | undefined, string | null | undefined] => {
      const who = render(identity).querySelector(".receipt-who");
      return [who?.getAttribute("data-lamp"), who?.textContent];
    };
    expect(line({ kind: "you" })).toEqual(["ok", "Paid to you: the To address is the account signed in here."]);
    expect(line({ kind: "by-you", label: "Rakoto Design" })).toEqual(["ok", "Paid by you to Rakoto Design, a saved contact."]);
    expect(line({ kind: "by-you", label: null })).toEqual(["ok", "Paid by you: the From address is your account."]);
    expect(line({ kind: "contact", label: "Rakoto Design" })).toEqual(["ok", "Paid to Rakoto Design, a saved contact."]);
    expect(line({ kind: "not-you" })[0]).toBe("wait");
    expect(line({ kind: "not-you" })[1]).toMatch(/^Not paid to you: the To address is not the account signed in here\./);
    expect(line({ kind: "unknown" })).toEqual(["off", "Compare the To address group by group with your own: this receipt proves which address was paid, not who owns it."]);
  });
});

describe("payeeIdentity", () => {
  it("tells the merchant a look-alike of their own address is not theirs (first and last four hex digits equal)", async () => {
    const merchant = app({ address: PAYEE, kind: "passkey" });
    expect(LOOK_ALIKE.slice(0, 6).toLowerCase()).toBe(PAYEE.slice(0, 6).toLowerCase());
    expect(LOOK_ALIKE.slice(-4).toLowerCase()).toBe(PAYEE.slice(-4).toLowerCase());
    expect(await payeeIdentity(merchant, proof(LOOK_ALIKE))).toEqual({ kind: "not-you" });
    expect(await payeeIdentity(merchant, proof(PAYEE))).toEqual({ kind: "you" });
    // Addresses compare as addresses, whatever their checksum case.
    expect(await payeeIdentity(app({ address: PAYEE.toLowerCase() as Address, kind: "injected" }), proof(PAYEE))).toEqual({ kind: "you" });
  });

  it("reads the payer's own payments and the address book, and asks for the comparison when it knows nothing", async () => {
    const saved = [contact(PAYEE, "Rakoto Design")];
    expect(await payeeIdentity(app({ address: PAYER, kind: "injected" }, saved), proof())).toEqual({ kind: "by-you", label: "Rakoto Design" });
    expect(await payeeIdentity(app({ address: PAYER, kind: "injected" }), proof())).toEqual({ kind: "by-you", label: null });
    expect(await payeeIdentity(app(null, saved), proof())).toEqual({ kind: "contact", label: "Rakoto Design" });
    // A saved contact never vouches for a look-alike of it.
    expect(await payeeIdentity(app(null, saved), proof(LOOK_ALIKE))).toEqual({ kind: "unknown" });
    expect(await payeeIdentity(app({ address: PAYER.replace("90F7", "1111") as Address, kind: "injected" }, saved), proof(LOOK_ALIKE))).toEqual({ kind: "not-you" });
    expect(await payeeIdentity(app(null), proof())).toEqual({ kind: "unknown" });
  });
});
