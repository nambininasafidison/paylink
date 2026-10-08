// SPDX-License-Identifier: MIT
/**
 * `/till/`: the counter display (spec §2.1 T1 "Till mode", §3.8). One big display window, big condensed numerals, an
 * LED that turns green with a chime when a payment lands.
 *
 * Armed (`/till/#<invoice fragment>`): only a receipt-verified `Paid` with that invoice's key, and for a fixed invoice
 * exactly its amount, lights it (invoice spec §13.4, threat T-44). Watching (no fragment): every verified `Paid` to the
 * connected payee lights it, with the amount in large digits, because any amount can arrive on a receive card.
 *
 * Reads the chain directly: `eth_getLogs` every second from `head − 10` (never more than the 100-block cap of Monad's
 * public RPCs), filtered on the key or payee topic; every log is re-verified as a receipt before the LED changes.
 */
import { decodeInvoiceFragment, fragmentOf, isPaymentForArmedInvoice, PAID_TOPIC, sanitizeMemoForDisplay, verifyReceipt } from "@paylink/sdk";
import type { DecodedInvoiceLink, ReceiptProof } from "@paylink/sdk";
import { formatDateTime, formatSeconds } from "@paylink/i18n";
import { pad } from "viem";
import type { Address, Hex } from "viem";
import type { PageDefinition } from "../app/boot.ts";
import { plateText } from "../app/chains.ts";
import type { App } from "../app/context.ts";
import { intro, notes, routeHref } from "../app/shell.ts";
import type { PageUi } from "../app/shell.ts";
import { connectLabel, pickWallet } from "../app/wallet-ui.ts";
import { decodeUiError } from "../core/errors.ts";
import { prefs } from "../core/prefs.ts";
import { displayAmount, shortHex } from "../core/format.ts";
import { ariaryLabel } from "../core/fx.ts";
import { num, setStatus, statusLine } from "../ui/atoms.ts";
import { h, replace } from "../ui/h.ts";
import { announce } from "../ui/live.ts";
import type { ChainDefinition } from "@paylink/chains";

const LOOKBACK_BLOCKS = 10n;
const MAX_RANGE = 99n;
const POLL_MS = 1000;

export const tillPage: PageDefinition = {
  route: "till",
  payer: false,
  title: "till.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(intro({ kicker: t("till.kicker"), title: [t("till.h1a"), t("till.h1b")], lede: t("till.lede") }));
    ui.aside.append(
      notes(t("till.notes.title"), [
        [t("till.notes.armed"), t("till.notes.armedText")],
        [t("till.notes.card"), t("till.notes.cardText")],
      ]),
    );
    const section = h("section", { class: "view view-till", attrs: { "aria-labelledby": "till-head" } });
    ui.views.append(section);
    void app.session.ready.then(() => {
      renderTill(app, ui, section);
    });
  },
};

/** A chime in two tones through Web Audio (no audio file); the context is created by the Start key's gesture. */
class Chime {
  private context: AudioContext | null = null;

  arm(): void {
    if (this.context === null && typeof AudioContext === "function") {
      this.context = new AudioContext();
    }
    void this.context?.resume();
  }

  play(): void {
    const context = this.context;
    if (context === null || !prefs.chime.get()) {
      return;
    }
    const start = context.currentTime;
    for (const [i, frequency] of [880, 1318.5].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.25, start + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.14 + 0.22);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + i * 0.14);
      oscillator.stop(start + i * 0.14 + 0.24);
    }
  }
}

interface Watch {
  readonly chain: ChainDefinition;
  readonly contract: Address;
  /** Topic filter: [Paid, key | null, payee | null]. */
  readonly topics: readonly (Hex | null)[];
  readonly armed: DecodedInvoiceLink | null;
  readonly payee: Address;
}

function renderTill(app: App, ui: PageUi, section: HTMLElement): void {
  const { t } = app.i18n;
  const head = h("div", { class: "view-head" }, h("h2", { attrs: { id: "till-head" } }, t("till.head")));
  const fragment = fragmentOf(location.href);
  let armed: DecodedInvoiceLink | null = null;
  if (fragment !== "") {
    try {
      armed = decodeInvoiceFragment(fragment, app.registry);
    } catch (error) {
      const status = statusLine();
      const decoded = decodeUiError(app, error);
      setStatus(status, "err", decoded.message, decoded.code);
      ui.plate(t("till.head"), "err");
      replace(section, head, status);
      return;
    }
  }
  const account = app.session.account();
  if (armed === null && account === null) {
    ui.plate(t("till.head"), "off");
    replace(
      section,
      head,
      h("div", { class: "empty-state" }, h("p", null, t("till.connect")), h("button", { class: "key key-primary", attrs: { type: "button" }, on: { click: () => { void pickWallet(app).then(() => { renderTill(app, ui, section); }); } } }, connectLabel(app))),
      h("p", { class: "field-hint" }, t("till.armHint"), " ", h("a", { attrs: { href: routeHref(app, "ledger") } }, t("till.fromLedger"))),
    );
    return;
  }
  const chains = armed === null ? app.registry.chains.filter((c) => app.registry.v2Target(c.chainId) !== undefined) : [armed.target.chain];
  const chain = chains[0];
  const target = chain === undefined ? undefined : app.registry.v2Target(chain.chainId);
  if (chain === undefined || target === undefined) {
    ui.plate(t("till.head"), "off");
    replace(section, head, h("p", { class: "state-note" }, t("till.noDeployment")));
    return;
  }
  const payee: Address | undefined = armed?.invoice.payee ?? account?.address;
  if (payee === undefined) {
    return;
  }
  const watch: Watch = {
    chain,
    contract: target.deployment.address,
    topics: [PAID_TOPIC, armed === null ? null : armed.key, armed === null ? pad(payee.toLowerCase() as Hex, { size: 32 }) : null],
    armed,
    payee,
  };
  ui.plate(plateText(chain), "wait");
  const token = armed?.token ?? chain.tokens.find((x) => x.listing === "default");
  const expected = armed !== null && armed.invoice.amount !== 0n ? displayAmount(armed.invoice.amount, armed.token, app.locale) : null;
  const ledText = h("span", { class: "till-led" }, t("till.idle"));
  const figure = h("div", { class: "till-figure" }, expected === null ? num(t("ticket.any"), "any") : num(expected), h("span", { class: "unit" }, token?.symbol ?? ""));
  const fxLine = h("p", { class: "till-fx" }, armed !== null && armed.invoice.amount !== 0n ? ariaryLabel(armed.invoice.amount, armed.token, app.fx, app.locale, (p) => t("fx.estimate", p)) : null);
  const caption = h("p", { class: "till-caption" }, armed?.memo === null || armed === null ? t("till.watching", { address: shortHex(payee) }) : sanitizeMemoForDisplay(armed.memo));
  const settled = h("p", { class: "till-settled", attrs: { "aria-live": "polite" } });
  const log = h("ul", { class: "till-log", attrs: { "aria-label": t("till.log") } }, h("li", null, t("till.noPayments")));
  const display = h("div", { class: "screen till", attrs: { "data-state": "idle", role: "region", "aria-label": t("till.display") } }, h("div", { class: "till-top" }, ledText, h("span", null, `${chain.label} · ${String(chain.chainId)}`)), figure, fxLine, caption, settled, log);
  const status = statusLine();
  const chime = new Chime();
  let running = false;
  let timer = 0;
  let from: bigint | null = null;
  const seen = new Set<string>();
  const entries: HTMLElement[] = [];

  const light = (state: "idle" | "waiting" | "paid" | "error", text: string): void => {
    display.setAttribute("data-state", state === "waiting" ? "waiting" : state);
    ledText.textContent = text;
    ui.plate(plateText(chain), state === "paid" ? "ok" : state === "error" ? "err" : "wait");
  };

  const arrived = (proof: ReceiptProof, delay: number): void => {
    const amount = displayAmount(proof.amount, proof.tokenInfo, app.locale);
    const matches = watch.armed === null || isPaymentForArmedInvoice(proof, { key: watch.armed.key, invoice: watch.armed.invoice });
    entries.unshift(h("li", null, h("span", null, formatDateTime(app.locale, proof.timestamp, { timeStyle: "medium" })), h("b", null, `${amount} ${proof.tokenInfo.symbol}`)));
    replace(log, entries.slice(0, 5));
    if (!matches) {
      setStatus(status, "warn", t("till.mismatch", { amount, symbol: proof.tokenInfo.symbol }));
      return;
    }
    replace(figure, num(amount), h("span", { class: "unit" }, proof.tokenInfo.symbol));
    fxLine.textContent = ariaryLabel(proof.amount, proof.tokenInfo, app.fx, app.locale, (p) => t("fx.estimate", p)) ?? "";
    light("paid", t("till.paid"));
    settled.textContent = t("till.settled", { seconds: formatSeconds(app.locale, delay) });
    if (watch.armed !== null && watch.armed.invoice.amount === 0n) {
      setStatus(status, "warn", t("till.openAmountNotice"));
    } else {
      setStatus(status, "ok", t("till.received", { amount, symbol: proof.tokenInfo.symbol }));
    }
    announce(t("till.receivedSaid", { amount, symbol: proof.tokenInfo.symbol }));
    chime.play();
  };

  const poll = async (): Promise<void> => {
    const client = app.client(chain);
    try {
      const head = await client.getBlockNumber();
      let start = from ?? (head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n);
      if (head - start > MAX_RANGE) {
        start = head - MAX_RANGE;
      }
      if (start <= head) {
        const logs = await client.getLogs({ address: watch.contract, fromBlock: start, toBlock: head, topics: watch.topics });
        for (const log of logs) {
          const id = `${log.transactionHash ?? ""}:${log.logIndex ?? ""}`;
          if (log.transactionHash === null || log.logIndex === null || seen.has(id)) {
            continue;
          }
          seen.add(id);
          const reference = { chainId: chain.chainId, txHash: log.transactionHash, logIndex: Number(log.logIndex) };
          const verification = await verifyReceipt({ registry: app.registry, client, reference, ...(watch.armed === null ? {} : { paid: watch.armed }) });
          if (verification.valid && verification.proof.payee.toLowerCase() === watch.payee.toLowerCase()) {
            arrived(verification.proof, Math.max(0, Date.now() / 1000 - Number(verification.proof.timestamp)));
          }
        }
      }
      from = head + 1n;
      if (display.getAttribute("data-state") === "error") {
        light("waiting", t("till.waiting"));
        setStatus(status, "", "");
      }
    } catch {
      light("error", t("till.error"));
    }
  };

  const loop = (): void => {
    if (!running) {
      return;
    }
    void poll().finally(() => {
      if (running) {
        timer = window.setTimeout(loop, POLL_MS);
      }
    });
  };

  const startKey = h("button", { class: "key key-primary", attrs: { type: "button" } }, t("till.start"));
  const chimeKey = h("button", { class: "key key-line", attrs: { type: "button", "aria-pressed": prefs.chime.get() ? "true" : "false" } }, prefs.chime.get() ? t("till.chimeOn") : t("till.chimeOff"));
  const fullKey = h("button", { class: "key key-line", attrs: { type: "button" } }, t("till.fullscreen"));
  let wakeLock: { release(): Promise<void> } | null = null;
  startKey.addEventListener("click", () => {
    running = !running;
    if (running) {
      chime.arm();
      from = null;
      light("waiting", t("till.waiting"));
      startKey.textContent = t("till.stop");
      if ("wakeLock" in navigator) {
        navigator.wakeLock.request("screen").then((sentinel) => { wakeLock = sentinel; }).catch(() => undefined);
      }
      loop();
    } else {
      window.clearTimeout(timer);
      light("idle", t("till.idle"));
      startKey.textContent = t("till.start");
      void wakeLock?.release().catch(() => undefined);
      wakeLock = null;
    }
  });
  chimeKey.addEventListener("click", () => {
    const on = !prefs.chime.get();
    prefs.chime.set(on);
    chimeKey.setAttribute("aria-pressed", on ? "true" : "false");
    chimeKey.textContent = on ? t("till.chimeOn") : t("till.chimeOff");
  });
  fullKey.addEventListener("click", () => {
    const root = document.documentElement;
    if (document.fullscreenElement === null) {
      void ui.terminal.requestFullscreen().then(() => { root.dataset["fullscreen"] = "true"; }).catch(() => undefined);
    } else {
      void document.exitFullscreen().catch(() => undefined);
    }
  });
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === null) {
      delete document.documentElement.dataset["fullscreen"];
    }
  });
  replace(
    section,
    h("div", { class: "view-head" }, h("h2", { attrs: { id: "till-head" } }, t("till.head")), h("span", { class: "view-meta" }, armed === null ? t("till.modeWatch") : t("till.modeArmed"))),
    display,
    status,
    startKey,
    h("div", { class: "key-row" }, chimeKey, fullKey),
  );
}
