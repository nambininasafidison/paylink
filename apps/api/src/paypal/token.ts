// SPDX-License-Identifier: MIT
/**
 * The OAuth 2.0 access token (P1, docs/paypal/SPEC.md §7.1): fetched with the client credentials, cached in this isolate
 * and in the Global Durable Object (so the Worker's isolates share one token instead of each fetching its own), and used
 * until `expires_in` − 10 minutes. Concurrent callers in one isolate share one fetch. A token PayPal refused (401) is
 * dropped and never handed out again by this isolate, even if the shared store still holds it, until a fresh one
 * replaces it there.
 *
 * The store is a cache: when it cannot be read or written (an outage, or the scaffold's stub), the isolate's own copy
 * still works, and the failure is logged once, as a class name, never with the token.
 *
 * Owner: PayPal spine workstream.
 */
import type { Logger } from "../core/log.ts";
import { errorFields } from "../core/log.ts";
import type { AccessToken } from "./client.ts";
import type { OAuthTokenResponse } from "./types.ts";

/** Refresh margin before PayPal's expiry (§7.1 P1). */
export const TOKEN_MARGIN_MS = 10 * 60 * 1000;

/** The subset of the Global store the token cache uses (src/store/types.ts). */
export interface TokenStore {
  getToken(now: number): Promise<AccessToken | null>;
  putToken(token: AccessToken): Promise<void>;
}

/**
 * When a token fetched at `issuedAt` stops being used: `expires_in` − 10 min (§7.1), whatever lifetime PayPal gives (the
 * sandbox's token answered 32,326 s in the owner's capture of 2026-10-29, so it is used for 8 h 48 min 46 s). A token
 * that lives 20 minutes or less is used for half its life instead, so it is never used late.
 */
export function tokenExpiry(issuedAt: number, expiresInSeconds: number): number {
  const lifetime = expiresInSeconds * 1000;
  return issuedAt + (lifetime > 2 * TOKEN_MARGIN_MS ? lifetime - TOKEN_MARGIN_MS : Math.floor(lifetime / 2));
}

export class TokenCache {
  private memory: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;
  /** Tokens PayPal refused in this isolate (bounded: a refused token is replaced at once). */
  private readonly refused = new Set<string>();
  private storeWarned = false;
  private readonly fetchToken: () => Promise<OAuthTokenResponse>;
  private readonly clock: () => number;
  private readonly store: TokenStore | null;
  private readonly logger: Logger;

  constructor(fetchToken: () => Promise<OAuthTokenResponse>, clock: () => number, store: TokenStore | null, logger: Logger) {
    this.fetchToken = fetchToken;
    this.clock = clock;
    this.store = store;
    this.logger = logger;
  }

  /** A token valid now: this isolate's, the store's, or a fresh one (one fetch for all concurrent callers). */
  async get(): Promise<string> {
    const now = this.clock();
    if (this.memory !== null && this.memory.expiresAtMs > now && !this.refused.has(this.memory.token)) {
      return this.memory.token;
    }
    this.inflight ??= this.load(now).finally(() => {
      this.inflight = null;
    });
    return (await this.inflight).token;
  }

  /** Drops `token` after PayPal answered 401 to it: the next `get` fetches a fresh one. */
  invalidate(token: string): void {
    if (this.refused.size >= 16) {
      this.refused.clear();
    }
    this.refused.add(token);
    if (this.memory?.token === token) {
      this.memory = null;
    }
  }

  private async load(now: number): Promise<AccessToken> {
    const stored = await this.fromStore(now);
    if (stored !== null) {
      this.memory = stored;
      return stored;
    }
    const issuedAt = this.clock();
    const response = await this.fetchToken();
    const token: AccessToken = { token: response.access_token, expiresAtMs: tokenExpiry(issuedAt, response.expires_in) };
    this.memory = token;
    this.refused.delete(token.token);
    await this.toStore(token);
    return token;
  }

  private async fromStore(now: number): Promise<AccessToken | null> {
    if (this.store === null) {
      return null;
    }
    try {
      const token = await this.store.getToken(now);
      return token !== null && token.expiresAtMs > now && !this.refused.has(token.token) ? token : null;
    } catch (error) {
      this.warnStore(error);
      return null;
    }
  }

  private async toStore(token: AccessToken): Promise<void> {
    if (this.store === null) {
      return;
    }
    try {
      await this.store.putToken(token);
    } catch (error) {
      this.warnStore(error);
    }
  }

  private warnStore(error: unknown): void {
    if (!this.storeWarned) {
      this.storeWarned = true;
      this.logger.log("warn", "paypal.token.store-unavailable", errorFields(error));
    }
  }
}
