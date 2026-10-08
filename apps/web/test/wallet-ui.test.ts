// SPDX-License-Identifier: MIT
/** The wallet picker: one wallet connects straight away; several are listed with their own name and icon; none explains. */
import { createTranslator, EN } from "@paylink/i18n";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountProvider, Connector } from "../src/accounts/types.ts";
import { WalletError } from "../src/accounts/types.ts";
import type { App } from "../src/app/context.ts";
import type { Session } from "../src/app/session.ts";
import { pickWallet } from "../src/app/wallet-ui.ts";
import { payee } from "./helpers.ts";

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

function session(connectors: Connector[], refuse = new Set<string>()): Session & { connected: string[] } {
  let account: AccountProvider | null = null;
  const connected: string[] = [];
  return {
    connected,
    account: () => account,
    connectors: () => connectors,
    subscribe: () => () => undefined,
    ready: Promise.resolve(),
    connect: (id) => {
      if (refuse.has(id)) {
        return Promise.reject(new WalletError(4001, "User rejected the request."));
      }
      connected.push(id);
      const next = { address: payee.address, connector: connectors.find((c) => c.id === id) } as unknown as AccountProvider;
      account = next;
      return Promise.resolve(next);
    },
    disconnect: () => {
      account = null;
    },
  };
}

const appWith = (s: Session): App => ({ session: s, edition: { accountLayers: [{ id: "eip6963", kind: "injected" }] }, i18n: createTranslator("en", EN, { fallback: EN }) }) as unknown as App;
const wallet = (id: string, name: string, icon: string | null = ICON): Connector => ({ id, name, icon, layer: "eip6963" });

afterEach(() => {
  document.body.replaceChildren();
});

describe("pickWallet", () => {
  it("connects the only wallet without showing a list", async () => {
    const s = session([wallet("io.metamask", "MetaMask")]);
    const account = await pickWallet(appWith(s));
    expect(account?.address).toBe(payee.address);
    expect(s.connected).toEqual(["io.metamask"]);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("lists several wallets with their own icons, and connects the one picked", async () => {
    const s = session([wallet("io.metamask", "MetaMask"), wallet("io.rabby", "Rabby", null)]);
    const picked = pickWallet(appWith(s));
    await new Promise((r) => setTimeout(r, 0));
    const keys = [...document.querySelectorAll<HTMLButtonElement>("dialog .wallet-key")];
    expect(keys.map((k) => k.querySelector(".wallet-name")?.textContent)).toEqual(["MetaMask", "Rabby"]);
    expect(keys[0]?.querySelector("img")?.getAttribute("src")).toBe(ICON);
    expect(keys[1]?.querySelector(".wallet-glyph")?.textContent).toBe("RA");
    keys[1]?.click();
    expect((await picked)?.address).toBe(payee.address);
    expect(s.connected).toEqual(["io.rabby"]);
  });

  it("explains what to do when no wallet is installed, and resolves null when closed", async () => {
    const picked = pickWallet(appWith(session([])));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector("dialog .wallets-empty")?.textContent).toBe(EN["wallet.pick.none"]);
    document.querySelector<HTMLButtonElement>("dialog .modal-foot button")?.click();
    expect(await picked).toBeNull();
  });

  it("shows the refusal with its code when the only wallet declines", async () => {
    const picked = pickWallet(appWith(session([wallet("io.metamask", "MetaMask")], new Set(["io.metamask"]))));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector("dialog .status")?.textContent).toMatch(/Error code/);
    document.querySelector<HTMLDialogElement>("dialog")?.close();
    expect(await picked).toBeNull();
  });
});
