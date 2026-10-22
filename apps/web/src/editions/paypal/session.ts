// SPDX-License-Identifier: MIT
/**
 * The payee's session with the API (docs/paypal/SPEC.md §12.2, `POST /v1/session`): the wallet signs an EIP-712
 * `PayLinkSession` (domain "PayLink API" version 1 on Ethereum Sepolia, no verifying contract: nothing goes on chain),
 * and the API answers a bearer token valid at most 12 hours. Signing it moves nothing: no transaction, no fee, no
 * allowance. The token opens only this payee's own twins and desk.
 *
 * The token is kept in `sessionStorage` for the tab (the app is multi-page: create, desk and ledger share it), keyed
 * by the payee, and dropped when it expires, when the API refuses it (401) or when another account is connected. It
 * never goes to `localStorage`, a cookie or a URL.
 *
 * Owner: web edition workstream.
 */
import { PAYPAL_EDITION_CHAIN_ID, SESSION_DOMAIN, SESSION_MAX_SECONDS, SESSION_TYPES } from "@paylink/api-contract";
import type { PayLinkSessionMessage, SessionRequest } from "@paylink/api-contract";
import type { Address } from "viem";
import type { AccountProvider } from "../../accounts/types.ts";
import type { App } from "../../app/context.ts";
import { ApiError, postSession } from "./api.ts";
import type { PaypalApi } from "./api.ts";

const STORAGE_KEY = "paylink.paypal.session";
/** A token this close to its end is not used: the next call could outlive it. */
const MARGIN_MS = 60_000;

interface StoredSession {
  readonly payee: string;
  readonly token: string;
  readonly expiresAt: number;
}

function read(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<StoredSession>;
    return typeof value.payee === "string" && typeof value.token === "string" && typeof value.expiresAt === "number" ? (value as StoredSession) : null;
  } catch {
    return null;
  }
}

/** The stored token for `payee`, if it is still good for a while. */
export function storedSession(payee: Address, now = Date.now()): string | null {
  const stored = read();
  if (stored?.payee !== payee.toLowerCase() || stored.expiresAt - MARGIN_MS <= now) {
    return null;
  }
  return stored.token;
}

export function forgetSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage refused: nothing was kept.
  }
}

function keep(payee: Address, token: string, expiresAt: number): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ payee: payee.toLowerCase(), token, expiresAt } satisfies StoredSession));
  } catch {
    // Storage refused: the session lasts for this page only.
  }
}

/** The message a payee signs: this page's origin, now, at most 12 hours, a fresh 32-byte nonce. */
export function sessionMessage(payee: Address, origin: string, nowMs: number, random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): PayLinkSessionMessage {
  const issuedAt = Math.floor(nowMs / 1000);
  const nonce: `0x${string}` = `0x${[...random(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return { payee, origin, issuedAt: String(issuedAt), expiresAt: String(issuedAt + SESSION_MAX_SECONDS), nonce };
}

/**
 * Asks the wallet to sign a session (after switching it to Ethereum Sepolia: wallets refuse typed data whose domain
 * names another chain than the active one), then opens it with the API. Resolves with the token.
 */
export async function openSession(app: App, api: PaypalApi, account: AccountProvider): Promise<string> {
  const chain = app.registry.get(PAYPAL_EDITION_CHAIN_ID);
  if (chain !== undefined) {
    await account.switchChain(chain);
  }
  const session = sessionMessage(account.address, app.site.origin, Date.now());
  // The session's domain has no verifying contract (nothing on chain checks it): the wallet layer derives the
  // EIP712Domain type from the fields present, so the absent member is simply not part of the domain.
  const domain = { ...SESSION_DOMAIN, chainId: PAYPAL_EDITION_CHAIN_ID } as unknown as Parameters<AccountProvider["signTypedData"]>[0]["domain"];
  const signature = await account.signTypedData({
    domain,
    types: SESSION_TYPES,
    primaryType: "PayLinkSession",
    message: { payee: session.payee, origin: session.origin, issuedAt: BigInt(session.issuedAt), expiresAt: BigInt(session.expiresAt), nonce: session.nonce },
  });
  const request: SessionRequest = { chainId: PAYPAL_EDITION_CHAIN_ID, session, signature };
  const opened = await postSession(api, request);
  const expiresAt = Date.parse(opened.expiresAt);
  if (opened.payee.toLowerCase() !== account.address.toLowerCase() || Number.isNaN(expiresAt)) {
    throw new ApiError(200, "invalid-response");
  }
  keep(account.address, opened.token, expiresAt);
  return opened.token;
}

/**
 * Runs `work` with a session token for `account`: the stored one, else a new one (a wallet signature). A 401 drops the
 * stored token and, once, signs a new one and runs `work` again.
 */
export async function withSession<T>(app: App, api: PaypalApi, account: AccountProvider, work: (token: string) => Promise<T>, onSign?: () => void): Promise<T> {
  const stored = storedSession(account.address);
  const fresh = async (): Promise<string> => {
    onSign?.();
    return await openSession(app, api, account);
  };
  const token = stored ?? (await fresh());
  try {
    return await work(token);
  } catch (error) {
    // Only a stored token can have lapsed on the server's side: a token signed a moment ago is not signed again.
    if (stored !== null && error instanceof ApiError && error.code === "unauthorized") {
      forgetSession();
      return await work(await fresh());
    }
    throw error;
  }
}
