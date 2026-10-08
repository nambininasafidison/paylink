// SPDX-License-Identifier: MIT
/**
 * PayLink keys (Monad edition): Mera's ceremonies through a fake WebAuthn client that answers like an authenticator
 * with PRF, the derivation (checked against viem's own BIP-39/BIP-32 implementation, so two independent code paths
 * agree on the account a passkey derives), one assertion per signature, the address check that refuses another
 * passkey, the device record (public facts only, validated on read), the relying-party pin, and local transactions.
 */
import { MeraError } from "@category-labs/mera";
import type { WebAuthnClient } from "@category-labs/mera";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { getAddress, parseTransaction, recoverTypedDataAddress, recoverTransactionAddress } from "viem";
import type { Address, Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, createKey, EVM_ACCOUNT_PATH, PasskeyError, passkeyFailure, signIn, withPasskeySigner } from "../src/accounts/mera.ts";
import type { MeraModule } from "../src/accounts/passkey.ts";
import { CREATE_ID, parsePasskeyRecord, passkeyLayer, PasskeyUseError, SIGN_IN_ID } from "../src/accounts/passkey.ts";
import type { AccountDeps } from "../src/accounts/types.ts";
import { createSession } from "../src/app/session.ts";
import { prefs } from "../src/core/prefs.ts";
import { fakeChain, localChain, registry } from "./helpers.ts";

const RAW_HASH: Hex = `0x${"ee".repeat(32)}`;
/** A PRF output as an authenticator would return it for one credential and Mera's salt. */
const prf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
/** The account viem derives from the same entropy through its own BIP-39 and BIP-32 (an independent path). */
const viemAccount = (fill: number): Address => mnemonicToAccount(entropyToMnemonic(prf(fill), wordlist), { path: EVM_ACCOUNT_PATH }).address;

/** One authenticator: each created credential has its own PRF output; assertions answer for the allowed one. */
function authenticator(options: { prfOnCreate?: boolean; noPrf?: boolean } = {}): WebAuthnClient & { readonly calls: string[]; cancelNext: boolean } {
  const credentials = new Map<string, number>();
  const client = {
    calls: [] as string[],
    cancelNext: false,
    createCredential(request: Parameters<WebAuthnClient["createCredential"]>[0]) {
      client.calls.push(`create:${request.rp.id}:${request.user.name}`);
      if (client.cancelNext) {
        client.cancelNext = false;
        return Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
      }
      const id = new Uint8Array(16).fill(credentials.size + 1);
      credentials.set(Buffer.from(id).toString("hex"), credentials.size + 1);
      return Promise.resolve({
        credentialId: id,
        transports: ["internal", "hybrid"],
        prfEnabled: options.noPrf !== true,
        ...(options.prfOnCreate === true ? { prfOutput: prf(credentials.size) } : {}),
      });
    },
    getCredential(request: Parameters<WebAuthnClient["getCredential"]>[0]) {
      client.calls.push(`get:${request.rpId}:${request.allowCredential === undefined ? "any" : "pinned"}`);
      if (client.cancelNext) {
        client.cancelNext = false;
        return Promise.reject(new DOMException("cancelled", "NotAllowedError"));
      }
      const id = request.allowCredential?.credentialId ?? new Uint8Array(16).fill(1);
      const n = credentials.get(Buffer.from(id).toString("hex")) ?? 1;
      return Promise.resolve({ credentialId: id, ...(options.noPrf === true ? {} : { prfOutput: prf(n) }) });
    },
  };
  return client;
}

const typed = {
  domain: { name: "PayLink", version: "2", chainId: 10143, verifyingContract: "0x448eCce9711860502806A3d5B021a4f9Ba715082" as Address },
  types: { Cancel: [{ name: "key", type: "bytes32" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Cancel",
  message: { key: `0x${"11".repeat(32)}`, deadline: 1n },
} as const;

describe("Mera derivation", () => {
  it("derives the account viem derives from the same BIP-39 entropy at m/44'/60'/0'/0/0, and wipes the PRF output", async () => {
    const output = prf(7);
    expect(await addressOf(output)).toBe(viemAccount(7));
    expect([...output].every((b) => b === 0)).toBe(true);
    expect(await addressOf(prf(8))).not.toBe(viemAccount(7));
  });

  it("creates a passkey on the relying party, with PRF at creation or through a second ceremony", async () => {
    const atCreate = authenticator({ prfOnCreate: true });
    const created = await createKey({ rpId: "paylink-mg.pages.dev", label: "Rakoto Design", webAuthnClient: atCreate });
    expect(created.address).toBe(viemAccount(1));
    expect(created.credential.transports).toEqual(["internal", "hybrid"]);
    expect(atCreate.calls).toEqual(["create:paylink-mg.pages.dev:Rakoto Design"]);
    const later = authenticator();
    expect((await createKey({ rpId: "localhost", label: "x", webAuthnClient: later })).address).toBe(viemAccount(1));
    expect(later.calls).toEqual(["create:localhost:x", "get:localhost:pinned"]);
  });

  it("signs with one assertion per signature, verifiably by the derived address, and refuses another passkey", async () => {
    const client = authenticator({ prfOnCreate: true });
    const first = await createKey({ rpId: "localhost", label: "a", webAuthnClient: client });
    const second = await createKey({ rpId: "localhost", label: "b", webAuthnClient: client });
    const signature = await withPasskeySigner({ rpId: "localhost", credential: first.credential, expected: first.address, webAuthnClient: client }, async (account) => await account.signTypedData(typed));
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(first.address);
    expect(client.calls.filter((c) => c.startsWith("get:"))).toEqual(["get:localhost:pinned"]);
    await expect(withPasskeySigner({ rpId: "localhost", credential: second.credential, expected: first.address, webAuthnClient: client }, () => Promise.resolve(1))).rejects.toMatchObject({ failure: "other-key" });
  });

  it("finds the account of a known or any passkey of the site", async () => {
    const client = authenticator({ prfOnCreate: true });
    const made = await createKey({ rpId: "localhost", label: "a", webAuthnClient: client });
    expect((await signIn({ rpId: "localhost", credential: made.credential, webAuthnClient: client })).credential).toEqual(made.credential);
    const any = await signIn({ rpId: "localhost", webAuthnClient: client });
    expect(any.address).toBe(made.address);
    expect(client.calls.slice(-2)).toEqual(["get:localhost:pinned", "get:localhost:any"]);
  });

  it("names Mera's failures: cancelled, no PRF, anything else", async () => {
    const cancelled = authenticator();
    cancelled.cancelNext = true;
    await expect(createKey({ rpId: "localhost", label: "a", webAuthnClient: cancelled })).rejects.toMatchObject({ failure: "cancelled" });
    await expect(createKey({ rpId: "localhost", label: "a", webAuthnClient: authenticator({ noPrf: true }) })).rejects.toMatchObject({ failure: "prf-unavailable" });
    await expect(signIn({ rpId: "localhost", webAuthnClient: authenticator({ noPrf: true }) })).rejects.toMatchObject({ failure: "prf-unavailable" });
    expect(passkeyFailure(new MeraError("INPUT_INVALID", "x")).failure).toBe("failed");
    expect(passkeyFailure(new Error("x")).failure).toBe("failed");
    const own = new PasskeyError("other-key", "x");
    expect(passkeyFailure(own)).toBe(own);
  });
});

/** In-memory localStorage stand-in. */
function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => {
      items.set(k, v);
    },
    removeItem: (k) => {
      items.delete(k);
    },
  };
}

/** The layer over the real `mera.ts`, with the fake authenticator injected. */
function layerWith(client: WebAuthnClient, options: { rpId?: string | null; hostname?: string; protocol?: string; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const storage = options.storage ?? memoryStorage();
  const load = (): Promise<MeraModule> =>
    Promise.resolve({
      createKey: (o) => createKey({ ...o, webAuthnClient: client }),
      signIn: (o) => signIn({ ...o, webAuthnClient: client }),
      withPasskeySigner: (o, use) => withPasskeySigner({ ...o, webAuthnClient: client }, use as never),
    });
  const layer = passkeyLayer({
    rpId: options.rpId === undefined ? null : options.rpId,
    defaultChainId: 10143,
    storage,
    location: { hostname: options.hostname ?? "localhost", protocol: options.protocol ?? "http:" },
    load,
    webAuthnAvailable: () => true,
  });
  return { layer, storage };
}

afterEach(() => {
  localStorage.clear();
});

describe("passkey layer", () => {
  it("creates a key, remembers only public facts, and restores it silently on the next page", async () => {
    const client = authenticator({ prfOnCreate: true });
    const { layer, storage } = layerWith(client);
    expect(layer.kind).toBe("passkey");
    const account = await layer.connect(CREATE_ID, { silent: false, label: "Rakoto Design" });
    expect(account?.address).toBe(viemAccount(1));
    expect(account?.kind).toBe("passkey");
    const record = parsePasskeyRecord(storage.items.get("paylink.passkey") ?? null);
    expect(record).toMatchObject({ version: 1, rpId: "localhost", address: viemAccount(1), label: "Rakoto Design" });
    expect(Object.keys(record ?? {}).sort()).toEqual(["address", "createdAt", "credentialId", "label", "rpId", "transports", "version"]);
    // A new page: no prompt, same account.
    const calls = client.calls.length;
    const next = layerWith(client, { storage });
    const restored = await next.layer.connect("passkey", { silent: true });
    expect(restored?.address).toBe(viemAccount(1));
    expect(client.calls.length).toBe(calls);
  });

  it("signs typed data with one fingerprint, and sends its own transactions through the registry RPC", async () => {
    const client = authenticator({ prfOnCreate: true });
    const { layer } = layerWith(client);
    const fake = fakeChain();
    const sent: Hex[] = [];
    const deps: AccountDeps = { registry, client: () => ({ ...fake.client, sendRawTransaction: (raw: Hex): Promise<Hex> => { sent.push(raw); return Promise.resolve(RAW_HASH); } }) };
    layer.bind?.(deps);
    const account = await layer.connect(CREATE_ID, { silent: false });
    if (account === null) {
      throw new Error("no account");
    }
    expect(await account.chainId()).toBe(10143);
    await account.switchChain(localChain());
    expect(await account.chainId()).toBe(localChain().chainId);
    const signature = await account.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
    const hash = await account.sendTransaction({ chainId: localChain().chainId, to: "0x5FbDB2315678afecb367f032d93F642f64180aa3", data: "0x1234", value: 0n, gas: 90_000n });
    expect(hash).toBe(RAW_HASH);
    const raw = sent[0] ?? "0x";
    const tx = parseTransaction(raw);
    expect(tx).toMatchObject({ type: "eip1559", chainId: localChain().chainId, gas: 90_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, nonce: 0 });
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(account.address);
    await expect(account.sendTransaction({ chainId: 999, to: "0x5FbDB2315678afecb367f032d93F642f64180aa3", data: "0x", value: 0n, gas: 1n })).rejects.toBeInstanceOf(PasskeyUseError);
  });

  it("signs in with a passkey of the site, and forgets the key on this device", async () => {
    const client = authenticator({ prfOnCreate: true });
    const { layer, storage } = layerWith(client);
    await layer.connect(CREATE_ID, { silent: false });
    storage.items.clear();
    const account = await layer.connect(SIGN_IN_ID, { silent: false });
    expect(account?.address).toBe(viemAccount(1));
    expect(layer.stored()?.label).toBe("PayLink key");
    const events: string[] = [];
    account?.onChange((e) => events.push(e));
    layer.forget();
    expect(layer.stored()).toBeNull();
    expect(events).toEqual(["disconnect"]);
    expect(await layer.connect("passkey", { silent: true })).toBeNull();
    expect(await layer.connect("io.metamask", { silent: false })).toBeNull();
  });

  it("works only on the pinned relying party, over a secure context, with WebAuthn", async () => {
    const client = authenticator({ prfOnCreate: true });
    expect(layerWith(client, { rpId: "paylink-mg.pages.dev", hostname: "paylink-mg.pages.dev", protocol: "https:" }).layer.support()).toEqual({ ok: true, rpId: "paylink-mg.pages.dev" });
    // A preview deployment could assert the same rpId: the production build refuses to run ceremonies there.
    const preview = layerWith(client, { rpId: "paylink-mg.pages.dev", hostname: "feature.paylink-mg.pages.dev", protocol: "https:" }).layer;
    expect(preview.support()).toEqual({ ok: false, reason: "wrong-host", rpId: "paylink-mg.pages.dev" });
    await expect(preview.connect(CREATE_ID, { silent: false })).rejects.toMatchObject({ failure: "unsupported" });
    expect(layerWith(client, { hostname: "example.test", protocol: "http:" }).layer.support()).toMatchObject({ ok: false, reason: "insecure" });
    const none = passkeyLayer({ rpId: null, defaultChainId: 10143, storage: memoryStorage(), location: { hostname: "localhost", protocol: "http:" }, webAuthnAvailable: () => false });
    expect(none.support()).toMatchObject({ ok: false, reason: "no-webauthn" });
    // A record made for another relying party is not this site's key.
    const storage = memoryStorage();
    storage.setItem("paylink.passkey", JSON.stringify({ version: 1, rpId: "elsewhere.test", credentialId: "AQID", address: viemAccount(1), label: "x", createdAt: 1 }));
    expect(layerWith(client, { storage }).layer.stored()).toBeNull();
  });

  it("maps a cancelled fingerprint to a use error the pages can word", async () => {
    const client = authenticator({ prfOnCreate: true });
    const { layer } = layerWith(client);
    const account = await layer.connect(CREATE_ID, { silent: false });
    client.cancelNext = true;
    await expect(account?.signTypedData(typed)).rejects.toMatchObject({ name: "PasskeyUseError", failure: "cancelled" });
    client.cancelNext = true;
    await expect(layer.connect(SIGN_IN_ID, { silent: false })).rejects.toMatchObject({ failure: "cancelled" });
  });

  it("validates the stored record: anything malformed is ignored", () => {
    const good = { version: 1, rpId: "localhost", credentialId: "AQID", transports: ["internal"], address: viemAccount(1).toLowerCase(), label: "a", createdAt: 1 };
    expect(parsePasskeyRecord(JSON.stringify(good))?.address).toBe(getAddress(viemAccount(1)));
    for (const bad of [
      null,
      "{",
      "[]",
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, credentialId: "a b" }),
      JSON.stringify({ ...good, address: "0x1234" }),
      JSON.stringify({ ...good, label: "x".repeat(65) }),
      JSON.stringify({ ...good, transports: ["<script>"] }),
      JSON.stringify({ ...good, createdAt: "now" }),
      "x".repeat(5000),
    ]) {
      expect(parsePasskeyRecord(bad)).toBeNull();
    }
  });

  it("restores through the session like any layer, and the session forgets it on disconnect", async () => {
    const client = authenticator({ prfOnCreate: true });
    const { layer, storage } = layerWith(client);
    const session = createSession([layer], 0);
    await session.ready;
    const account = await session.connect(CREATE_ID, { label: "Shop" });
    expect(prefs.wallet.get()).toBe(CREATE_ID);
    const next = createSession([layerWith(client, { storage }).layer], 0);
    await next.ready;
    expect(next.account()?.address).toBe(account.address);
    next.disconnect();
    expect(prefs.wallet.get()).toBeNull();
  });
});
