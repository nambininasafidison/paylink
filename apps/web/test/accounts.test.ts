// SPDX-License-Identifier: MIT
/**
 * The account layer: EIP-6963 discovery (validated announcements, legacy `window.ethereum` only as a fallback),
 * EIP-1193 calls with their error codes kept, EIP-3326 switch with the EIP-3085 add fallback built from the registry,
 * and the session that remembers a wallet by its rdns and restores it without a prompt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { addChainParameters, eip6963Layer, isBaseWallet, LEGACY_ID, parseProviderInfo, walletError } from "../src/accounts/eip6963.ts";
import type { Eip1193Provider } from "../src/accounts/eip6963.ts";
import type { Connector } from "../src/accounts/types.ts";
import { WalletError } from "../src/accounts/types.ts";
import { createSession } from "../src/app/session.ts";
import { prefs } from "../src/core/prefs.ts";
import { CHAIN_ID, CONTRACT, localChain, payee, SCRIPT_URL } from "./helpers.ts";

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

interface FakeWallet extends Eip1193Provider {
  readonly requests: { method: string; params: readonly unknown[] }[];
  chain: number;
  readonly known: Set<number>;
  accounts: string[];
  fail: Map<string, { code: number; message: string }>;
  emit(event: string, value: unknown): void;
  /** Refuses the EIP-5792 2.0.0 shape as invalid parameters (an earlier-draft wallet). */
  legacyBatch: boolean;
  polls: number;
}

function fakeWallet(): FakeWallet {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const answer = (method: string, params: readonly unknown[]): unknown => {
    wallet.requests.push({ method, params });
    const failure = wallet.fail.get(method);
    if (failure !== undefined) {
      wallet.fail.delete(method);
      throw Object.assign(new Error(failure.message), { code: failure.code });
    }
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return wallet.accounts;
      case "eth_chainId":
        return `0x${wallet.chain.toString(16)}`;
      case "wallet_switchEthereumChain": {
        const id = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
        if (!wallet.known.has(id)) {
          throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        }
        wallet.chain = id;
        return null;
      }
      case "wallet_addEthereumChain": {
        const id = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
        wallet.known.add(id);
        wallet.chain = id;
        return null;
      }
      case "eth_signTypedData_v4":
        return `0x${"AB".repeat(65)}`;
      case "eth_sendTransaction":
        return `0x${"CD".repeat(32)}`;
      case "wallet_getCapabilities":
        return { [`0x${wallet.chain.toString(16)}`]: { atomic: { status: "supported" } } };
      case "wallet_sendCalls": {
        const version = (params[0] as { version: string }).version;
        if (version === "2.0.0" && wallet.legacyBatch) {
          throw Object.assign(new Error("invalid params"), { code: -32602 });
        }
        return version === "1.0" ? "0xbatch" : { id: "0xbatch" };
      }
      case "wallet_getCallsStatus": {
        wallet.polls += 1;
        return wallet.polls < 2 ? { status: 100 } : { status: 200, receipts: [{ transactionHash: `0x${"EF".repeat(32)}` }] };
      }
      default:
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
    }
  };
  const wallet: FakeWallet = {
    requests: [],
    chain: 1,
    known: new Set([1]),
    accounts: [payee.address.toLowerCase()],
    fail: new Map(),
    legacyBatch: false,
    polls: 0,
    emit(event, value) {
      for (const fn of listeners.get(event) ?? []) {
        fn(value);
      }
    },
    request({ method, params = [] }) {
      return new Promise((resolve) => {
        resolve(answer(method, params));
      });
    },
    on(event, fn) {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
    },
    removeListener(event, fn) {
      listeners.get(event)?.delete(fn);
    },
  };
  return wallet;
}

function announce(target: Window, provider: Eip1193Provider, info: Record<string, unknown>): void {
  target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }));
}

const INFO = { uuid: "b3f4f2b0-0000-4000-8000-000000000001", name: "Test Wallet", icon: ICON, rdns: "dev.paylink.testwallet" };

afterEach(() => {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  prefs.wallet.set(null);
});

describe("EIP-6963 announcements", () => {
  it("accepts well-formed provider info and normalises the rdns", () => {
    expect(parseProviderInfo({ ...INFO, rdns: "IO.Metamask" })).toEqual({ ...INFO, rdns: "io.metamask" });
  });

  it("drops a non-image icon but keeps the wallet", () => {
    expect(parseProviderInfo({ ...INFO, icon: SCRIPT_URL })?.icon).toBeNull();
    expect(parseProviderInfo({ ...INFO, icon: "https://wallet.example/icon.png" })?.icon).toBeNull();
  });

  it.each([
    ["no rdns", { ...INFO, rdns: undefined }],
    ["a bare rdns", { ...INFO, rdns: "metamask" }],
    ["an empty name", { ...INFO, name: "  " }],
    ["a long name", { ...INFO, name: "x".repeat(65) }],
    ["a long uuid", { ...INFO, uuid: "u".repeat(65) }],
    ["no object", "MetaMask"],
  ])("rejects %s", (_name, info) => {
    expect(parseProviderInfo(info)).toBeNull();
  });

  it("lists announced wallets once each, and ignores announcements without a provider", () => {
    const layer = eip6963Layer(window, 10);
    const seen: (readonly Connector[])[] = [];
    const stop = layer.watch((list) => seen.push(list));
    const wallet = fakeWallet();
    announce(window, wallet, INFO);
    announce(window, wallet, INFO);
    announce(window, { notAProvider: true } as unknown as Eip1193Provider, { ...INFO, rdns: "evil.example" });
    stop();
    expect(seen.at(-1)).toEqual([{ id: "dev.paylink.testwallet", name: "Test Wallet", icon: ICON, layer: "eip6963" }]);
  });

  it("offers a legacy window.ethereum only when nobody announced", async () => {
    (window as unknown as { ethereum: Eip1193Provider }).ethereum = fakeWallet();
    const layer = eip6963Layer(window, 5);
    const seen: (readonly Connector[])[] = [];
    layer.watch((list) => seen.push(list));
    await vi.waitFor(() => {
      expect(seen.at(-1)?.map((c) => c.id)).toEqual([LEGACY_ID]);
    });
    const account = await layer.connect(LEGACY_ID, { silent: true });
    expect(account?.address).toBe(payee.address);
  });
});

describe("Base Account wallets", () => {
  it("names only the Base app and Coinbase Wallet (EIP-6963 rdns com.coinbase.wallet) as Base Account", () => {
    const connector = (id: string, layer = "eip6963"): Connector => ({ id, name: id, icon: null, layer });
    expect(isBaseWallet(connector("com.coinbase.wallet"))).toBe(true);
    // A wallet with EIP-5792 batches is not Base Account: MetaMask (an EIP-7702 smart account), Rabby, the legacy
    // injected provider, or anything claiming the rdns outside the EIP-6963 layer.
    expect(isBaseWallet(connector("io.metamask"))).toBe(false);
    expect(isBaseWallet(connector("io.rabby"))).toBe(false);
    expect(isBaseWallet(connector(LEGACY_ID))).toBe(false);
    expect(isBaseWallet(connector("com.coinbase.wallet", "passkey"))).toBe(false);
  });
});

describe("injected accounts", () => {
  async function connected(wallet = fakeWallet()) {
    const layer = eip6963Layer(window, 5);
    layer.watch(() => undefined);
    announce(window, wallet, INFO);
    const account = await layer.connect(INFO.rdns, { silent: false });
    if (account === null) {
      throw new Error("not connected");
    }
    return { wallet, account, layer };
  }

  it("reads EIP-5792 capabilities and sends an atomic batch, polling its status until final", async () => {
    const { wallet, account } = await connected();
    expect(await account.atomicCapability?.(1)).toBe("supported");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const pending = account.sendCalls?.({ chainId: 1, calls: [{ to: CONTRACT, data: "0x1234", value: 0n }] });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(await pending).toEqual({ status: "confirmed", txHashes: [`0x${"ef".repeat(32)}`] });
    } finally {
      vi.useRealTimers();
    }
    const sent = wallet.requests.find((r) => r.method === "wallet_sendCalls")?.params[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ version: "2.0.0", chainId: "0x1", atomicRequired: true, calls: [{ to: CONTRACT, data: "0x1234", value: "0x0" }] });
    expect(String(sent["from"]).toLowerCase()).toBe(payee.address.toLowerCase());
    // A wallet on the earlier draft: the same batch in its shape.
    const legacy = fakeWallet();
    legacy.legacyBatch = true;
    legacy.polls = 5;
    const old = await connected(legacy);
    expect(await old.account.sendCalls?.({ chainId: 1, calls: [] })).toMatchObject({ status: "confirmed" });
    expect(legacy.requests.filter((r) => r.method === "wallet_sendCalls").map((r) => (r.params[0] as { version: string }).version)).toEqual(["2.0.0", "1.0"]);
    // Another network: refused before any prompt; a wallet without EIP-5792: "unsupported".
    await expect(account.sendCalls?.({ chainId: 10143, calls: [] })).rejects.toMatchObject({ code: 4901 });
    wallet.fail.set("wallet_getCapabilities", { code: 4200, message: "unsupported" });
    expect(await account.atomicCapability?.(1)).toBe("unsupported");
  });

  it("connects with a prompt, or silently without one", async () => {
    const { wallet, layer } = await connected();
    expect(wallet.requests.map((r) => r.method)).toEqual(["eth_requestAccounts"]);
    wallet.accounts = [];
    expect(await layer.connect(INFO.rdns, { silent: true })).toBeNull();
    await expect(layer.connect(INFO.rdns, { silent: false })).rejects.toMatchObject({ code: 4100 });
    expect(await layer.connect("unknown.wallet", { silent: false })).toBeNull();
  });

  it("returns the checksummed address", async () => {
    const { account } = await connected();
    expect(account.address).toBe(payee.address);
    expect(account.kind).toBe("injected");
  });

  it("switches network, adding it from the registry when the wallet does not know it", async () => {
    const { wallet, account } = await connected();
    const chain = localChain();
    await account.switchChain(chain);
    expect(wallet.chain).toBe(CHAIN_ID);
    const add = wallet.requests.find((r) => r.method === "wallet_addEthereumChain");
    expect(add?.params[0]).toEqual(addChainParameters(chain));
    expect(addChainParameters(chain)).toMatchObject({ chainId: "0x7a69", rpcUrls: ["http://127.0.0.1:8545"] });
    // Already there: no request at all.
    const before = wallet.requests.length;
    await account.switchChain(chain);
    expect(wallet.requests.slice(before).map((r) => r.method)).toEqual(["eth_chainId"]);
  });

  it("keeps the wallet's error code when the user refuses", async () => {
    const { wallet, account } = await connected();
    wallet.fail.set("wallet_switchEthereumChain", { code: 4001, message: "User rejected the request." });
    await expect(account.switchChain(localChain())).rejects.toEqual(new WalletError(4001, "User rejected the request."));
  });

  it("refuses to send a transaction on another network", async () => {
    const { account } = await connected();
    await expect(account.sendTransaction({ chainId: CHAIN_ID, to: CONTRACT, data: "0x", value: 0n, gas: 100_000n })).rejects.toMatchObject({ code: 4901 });
  });

  it("sends with the explicit gas limit, and returns the lower-cased hash", async () => {
    const { wallet, account } = await connected();
    wallet.chain = CHAIN_ID;
    const hash = await account.sendTransaction({ chainId: CHAIN_ID, to: CONTRACT, data: "0x1234", value: 0n, gas: 123_456n });
    expect(hash).toBe(`0x${"cd".repeat(32)}`);
    expect(wallet.requests.at(-1)?.params[0]).toEqual({ from: payee.address, to: CONTRACT, data: "0x1234", value: "0x0", gas: "0x1e240" });
  });

  it("asks for eth_signTypedData_v4 with the EIP712Domain type derived from the domain", async () => {
    const { wallet, account } = await connected();
    const signature = await account.signTypedData({
      domain: { name: "PayLink", version: "2", chainId: CHAIN_ID, verifyingContract: CONTRACT },
      types: { Cancel: [{ name: "key", type: "bytes32" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Cancel",
      message: { key: `0x${"00".repeat(32)}`, deadline: 1n },
    });
    expect(signature).toBe(`0x${"ab".repeat(65)}`);
    const [from, json] = wallet.requests.at(-1)?.params ?? [];
    expect(from).toBe(payee.address);
    const typed = JSON.parse(json as string) as { types: Record<string, unknown>; message: { deadline: string } };
    expect(Object.keys(typed.types)).toEqual(["EIP712Domain", "Cancel"]);
    expect(typed.message.deadline).toBe("1");
  });

  it("reports account, chain and disconnect events, and detaches", async () => {
    const { wallet, account } = await connected();
    const events: string[] = [];
    const off = account.onChange((e) => events.push(e));
    wallet.emit("accountsChanged", []);
    wallet.emit("chainChanged", "0x1");
    wallet.emit("disconnect", {});
    off();
    wallet.emit("chainChanged", "0x2");
    expect(events).toEqual(["accounts", "chain", "disconnect"]);
  });

  it("wraps EIP-1193 errors and leaves anything else alone", () => {
    expect(walletError({ code: 4001, message: "no" })).toEqual(new WalletError(4001, "no"));
    const plain = new Error("x");
    expect(walletError(plain)).toBe(plain);
  });
});

describe("session", () => {
  it("restores a remembered wallet silently and follows account changes", async () => {
    const wallet = fakeWallet();
    prefs.wallet.set(INFO.rdns);
    const layer = eip6963Layer(window, 5);
    const session = createSession([layer], 20);
    announce(window, wallet, INFO);
    await session.ready;
    expect(session.account()?.address).toBe(payee.address);
    expect(wallet.requests.map((r) => r.method)).toEqual(["eth_accounts"]);
    expect(session.connectors().map((c) => c.id)).toEqual([INFO.rdns]);

    let changes = 0;
    session.subscribe(() => (changes += 1));
    wallet.accounts = [];
    wallet.emit("accountsChanged", []);
    await vi.waitFor(() => {
      expect(session.account()).toBeNull();
    });
    expect(changes).toBeGreaterThan(0);
  });

  it("connects with a prompt, remembers the choice, and forgets it on disconnect", async () => {
    const wallet = fakeWallet();
    const layer = eip6963Layer(window, 5);
    const session = createSession([layer], 5);
    announce(window, wallet, INFO);
    await session.ready;
    expect(session.account()).toBeNull();
    await session.connect(INFO.rdns);
    expect(prefs.wallet.get()).toBe(INFO.rdns);
    session.disconnect();
    expect(session.account()).toBeNull();
    expect(prefs.wallet.get()).toBeNull();
    await expect(session.connect("nobody.example")).rejects.toThrow(/no wallet/);
  });
});
