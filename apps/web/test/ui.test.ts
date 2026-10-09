// SPDX-License-Identifier: MIT
/**
 * The Precision Terminal pieces: QR codes drawn with createElementNS, the band selector (WAI-ARIA radio group), the
 * address grouped by four with one spoken label, the printed card (the receipt slip: test/proof-slip.test.ts), clipboard copies from canonical
 * state, and the service worker URL through the single Trusted Types policy.
 */
import qrcode from "qrcode-generator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerUrl } from "../src/pwa/register.ts";
import { addr, hexGroups, lamp, num, setStatus, statusLine } from "../src/ui/atoms.ts";
import { bandSelector, confirmBox, segmented } from "../src/ui/controls.ts";
import { announce, copyText, download, toast } from "../src/ui/live.ts";
import { correctionFor, qrMatrix, qrPath, qrSvg } from "../src/ui/qr.ts";
import { signingDisplay } from "../src/ui/signing.ts";
import { shortLink, ticket } from "../src/ui/ticket.ts";

const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const LINK = "https://paylink-mg.pages.dev/pay/#2.10143.cJl5cMUYEtw6AQx9AbUODRfcechmPzrWFxkxSHEdKPUzTuTtBwFmAgAAAAAA";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("QR codes", () => {
  it("encodes exactly the library's matrix, quiet zone and all, as one path of merged runs", () => {
    const matrix = qrMatrix(LINK);
    const reference = qrcode(0, "M");
    reference.addData(LINK, "Byte");
    reference.make();
    expect(matrix).toHaveLength(reference.getModuleCount());
    expect(matrix.every((row, r) => row.every((dark, c) => dark === reference.isDark(r, c)))).toBe(true);
    expect(qrPath([[true, true, false, true]])).toBe("M0 0h2v1h-2zM3 0h1v1h-1z");
    const element = qrSvg(LINK, "QR code of the payment link");
    expect(element.getAttribute("role")).toBe("img");
    expect(element.getAttribute("aria-label")).toBe("QR code of the payment link");
    expect(element.querySelector("path")?.getAttribute("d")).toBe(qrPath(matrix));
    expect(element.querySelector("svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("lowers error correction for long links so the code stays scannable", () => {
    expect(correctionFor("x".repeat(300))).toBe("M");
    expect(correctionFor("x".repeat(301))).toBe("L");
  });
});

describe("band selector", () => {
  const options = [
    { id: 10143, label: "MONAD", sub: "Testnet · 10143", disabled: false },
    { id: 84532, label: "BASE", sub: "Not deployed", disabled: true },
    { id: 421614, label: "ARB", sub: "Testnet · 421614", disabled: false },
  ];

  it("is one radio group with one tab stop, and arrow keys skip disabled bands", () => {
    const picked: number[] = [];
    const selector = bandSelector(options, 10143, "Network", (id) => picked.push(id));
    document.body.append(selector.element);
    const bands = [...selector.element.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    expect(selector.element.getAttribute("role")).toBe("radiogroup");
    expect(bands.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    bands[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(selector.value()).toBe(421614);
    expect(bands.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(document.activeElement).toBe(bands[2]);
    bands[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(selector.value()).toBe(10143);
    bands[1]?.click();
    expect(selector.value()).toBe(10143);
    selector.set(421614);
    expect(picked).toEqual([421614, 10143, 421614]);
  });

  it("uses native radios for segmented choices and a native checkbox for confirmations", () => {
    const seen: string[] = [];
    const seg = segmented("expiry", "Expires", [{ value: "1d", label: "1 day" }, { value: "7d", label: "7 days", sub: "default" }], "7d", (v) => seen.push(v));
    document.body.append(seg.element);
    const radios = seg.element.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect(seg.element.querySelector("legend")?.textContent).toBe("Expires");
    radios[0]?.click();
    expect(seg.value()).toBe("1d");
    expect(seen).toEqual(["1d"]);
    const box = confirmBox("This link never expires", () => undefined);
    document.body.append(box.element);
    box.element.querySelector("input")?.click();
    expect(box.checked()).toBe(true);
  });
});

describe("atoms", () => {
  it("shows an address in groups of four and says it once, as a sentence", () => {
    const element = addr(ADDRESS, "Paid to");
    const visible = [...element.querySelectorAll("[aria-hidden=true]")].map((s) => s.textContent);
    expect(visible).toEqual(["0x7099", "7970", "C518", "12dc", "3A01", "0C7d", "01b5", "0e0d", "17dc", "79C8"]);
    expect(element.querySelector(".sr-only")?.textContent).toBe("Paid to: 0x7099, 7970, C518, 12dc, 3A01, 0C7d, 01b5, 0e0d, 17dc, 79C8");
    expect(element.getAttribute("title")).toBe(ADDRESS);
    expect(hexGroups(`0x${"ab".repeat(32)}`).querySelectorAll("span:not(.hex-0x)")).toHaveLength(16);
  });

  it("sizes numerals, lights lamps and turns an error status into an alert with its code", () => {
    expect(num("25.50").style.getPropertyValue("--n")).toBe("5");
    expect(lamp("paid", "Paid").className).toBe("lamp paid");
    expect(lamp("open", "Open", true).className).toBe("pill open");
    const status = statusLine();
    setStatus(status, "err", "The network refused it.", "Error code SoldOut");
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.className).toBe("status err");
    expect(status.querySelector(".code")?.textContent).toBe("Error code SoldOut");
    setStatus(status, "", "Checking…");
    expect(status.getAttribute("role")).toBe("status");
  });
});

describe("printed pieces", () => {
  it("shortens a payment link on screen without ever looking complete: host, path, version and chain, then the last 8 characters", () => {
    const long = `https://paylink-mg.pages.dev/monad/pay/#2.10143.${"A".repeat(186)}.${"B".repeat(87)}kEqJH123`;
    expect(shortLink(long)).toBe("paylink-mg.pages.dev/monad/pay/#2.10143.AAAA…kEqJH123");
    expect(shortLink("http://localhost:4173/pay/#2.1.x")).toBe("localhost:4173/pay/#2.1.x");
  });

  it("prints the receive card with what the payer checks and the link's QR code", () => {
    const card = ticket({
      kind: "Invoice",
      amount: "25.50",
      symbol: "AUSD",
      anyAmount: "Any amount",
      memo: "Logo design",
      payee: ADDRESS,
      payeeLabel: "Paid to",
      terms: ["MONAD · 10143", "Valid until Oct 15, 2026"],
      url: LINK,
      scan: "Scan to pay",
      scanSub: "In AUSD digital dollars",
      qrLabel: "QR code",
      cardLabel: "Invoice for 25.50 AUSD",
    });
    expect(card.getAttribute("aria-label")).toBe("Invoice for 25.50 AUSD");
    expect(card.querySelector(".ticket-amt")?.textContent).toBe("25.50AUSD");
    // The whole link is printed on paper; the screen shows a deliberate short form whose ellipsis says it is cut.
    expect(card.querySelector(".printed-url-full")?.textContent).toBe(LINK.replace("https://", ""));
    const short = card.querySelector(".printed-url-short")?.textContent ?? "";
    expect(short).toBe(shortLink(LINK));
    if (short !== LINK.replace("https://", "")) {
      expect(short).toContain("…");
      expect(LINK.endsWith(short.split("…")[1] ?? "?")).toBe(true);
      expect(LINK.replace("https://", "").startsWith(short.split("…")[0] ?? "?")).toBe(true);
    }
    expect(card.querySelector(".qr path")).not.toBeNull();
    expect(card.querySelector(".lamba")?.getAttribute("aria-hidden")).toBe("true");
  });

});

describe("live regions and clipboard", () => {
  it("copies the canonical text it is given, never the DOM, and announces it", async () => {
    vi.useFakeTimers();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const key = document.createElement("button");
    key.textContent = "Copy";
    expect(await copyText(LINK, key, { idle: "Copy", done: "Copied", said: "Link copied" })).toBe(true);
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(key.textContent).toBe("Copied");
    vi.advanceTimersByTime(1700);
    expect(key.textContent).toBe("Copy");
    expect(document.querySelector("[aria-live=polite]")?.textContent).toBe("Link copied");
    vi.useRealTimers();
  });

  it("reports a refused clipboard", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    expect(await copyText(LINK, document.createElement("button"), { idle: "a", done: "b", said: "c" })).toBe(false);
  });

  it("shows one toast at a time, with an optional key", () => {
    let ran = 0;
    toast("First");
    toast("An update is ready", { label: "Reload", run: () => (ran += 1) });
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    // While it is up, the page reserves room for it at the bottom (scroll padding, body padding): focus is never hidden.
    expect(document.documentElement.style.getPropertyValue("--toast-clearance")).toMatch(/^\d+px$/);
    document.querySelector<HTMLButtonElement>(".toast button")?.click();
    expect(ran).toBe(1);
    expect(document.querySelector(".toast")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--toast-clearance")).toBe("");
    announce("x");
  });

  it("gives the room back when a toast without a key times out", () => {
    vi.useFakeTimers();
    toast("Saved", undefined, 1000);
    expect(document.documentElement.style.getPropertyValue("--toast-clearance")).not.toBe("");
    vi.advanceTimersByTime(1000);
    expect(document.querySelector(".toast")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--toast-clearance")).toBe("");
    vi.useRealTimers();
  });

  it("downloads through a same-origin blob URL and revokes it", () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue(`blob:${location.origin}/abc`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    download("ledger.csv", "text/csv", "a,b\r\n");
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1001);
    expect(revoke).toHaveBeenCalledWith(`blob:${location.origin}/abc`);
    vi.useRealTimers();
  });
});

describe("service worker URL under Trusted Types", () => {
  afterEach(() => {
    delete (globalThis as { trustedTypes?: unknown }).trustedTypes;
  });

  it("is the plain URL without Trusted Types", () => {
    expect(workerUrl("/monad/")).toBe("/monad/sw.js");
  });

  it("goes through the single paylink-sw policy, which accepts only the edition's own worker", () => {
    let rule: ((input: string) => string) | undefined;
    (globalThis as { trustedTypes?: unknown }).trustedTypes = {
      createPolicy: (name: string, rules: { createScriptURL(input: string): string }) => {
        expect(name).toBe("paylink-sw");
        rule = (input) => rules.createScriptURL(input);
        return { createScriptURL: (input: string) => rules.createScriptURL(input) };
      },
    };
    expect(workerUrl("/")).toBe("/sw.js");
    expect(() => rule?.("https://evil.example/sw.js")).toThrow(/only the edition's own service worker/);
  });
});

describe("signing display", () => {
  it("states what the signature approves in a labelled region, amount first, readable as a description list", () => {
    const display = signingDisplay({
      kicker: "Your key will sign",
      band: "MONAD",
      title: "Pay exactly this, once",
      amount: { label: "Amount", value: "25.50", unit: "AUSD" },
      rows: [["To", addr("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")], ["Valid for", "10 minutes, then void"]],
      note: "This signature can only pay this invoice.",
    });
    document.body.append(display);
    const title = display.querySelector("h3");
    expect(display.getAttribute("aria-labelledby")).toBe(title?.id);
    expect([...display.querySelectorAll(".readings dt")].map((dt) => dt.textContent)).toEqual(["Amount", "To", "Valid for"]);
    expect(display.querySelector(".is-amount dd")?.textContent).toBe("25.50AUSD");
    expect(display.querySelector(".signing-note")?.textContent).toBe("This signature can only pay this invoice.");
    const open = signingDisplay({ kicker: "k", band: "B", title: "t", amount: null, rows: [], note: "n" });
    expect(open.querySelector(".is-amount")).toBeNull();
    expect(open.querySelector("h3")?.id).not.toBe(title?.id);
    display.remove();
  });
});
