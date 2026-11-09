// SPDX-License-Identifier: MIT
/**
 * The connected account across pages. The app is multi-page, so the choice of wallet is remembered (its connector id,
 * nothing else) and restored silently on the next page with `eth_accounts`, which never prompts. Account and network
 * changes in the wallet update every subscriber in place.
 */
import type { AccountLayer, AccountProvider, Connector } from "../accounts/types.ts";
import { prefs } from "../core/prefs.ts";

export interface Session {
  account(): AccountProvider | null;
  connectors(): readonly Connector[];
  /** Called on every change of account, network or discovered wallets. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Connects with a prompt and remembers the choice. `label` names a new passkey. */
  connect(connectorId: string, options?: { readonly label?: string }): Promise<AccountProvider>;
  /** Forgets the choice (the wallet itself keeps its own permission; the user revokes it there). */
  disconnect(): void;
  /** Resolves once discovery has settled and any remembered wallet was restored. */
  readonly ready: Promise<void>;
}

/**
 * How long after an `accountsChanged` or `disconnect` the wallet's own list is read again before the account is
 * declared gone: MetaMask fires both while it switches accounts, locks or restarts its background worker, and
 * `eth_accounts` can answer an empty list for a moment though the site's permission stands.
 */
export const REREAD_DELAYS_MS: readonly number[] = [0, 400, 1200];

export function createSession(layers: readonly AccountLayer[], discoveryMs = 450, rereadDelaysMs: readonly number[] = REREAD_DELAYS_MS): Session {
  let account: AccountProvider | null = null;
  let detach: (() => void) | null = null;
  const lists = new Map<string, readonly Connector[]>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const layerOf = (connectorId: string): AccountLayer | undefined =>
    layers.find((layer) => (lists.get(layer.id) ?? []).some((c) => c.id === connectorId));

  /**
   * Re-reads the wallet's account silently (`eth_accounts`, never a prompt) after it said its accounts changed or it
   * disconnected: another account is adopted, the same one is kept as it is (no page re-renders, nothing is signed
   * again), and the account is declared gone only when every read of `rereadDelaysMs` finds none.
   */
  const reread = async (current: AccountProvider): Promise<void> => {
    const layer = layerOf(current.connector.id);
    for (const delay of rereadDelaysMs) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (account !== current) {
        return;
      }
      const fresh = await layer?.connect(current.connector.id, { silent: true }).catch(() => null);
      if (account !== current) {
        return;
      }
      if (fresh !== null && fresh !== undefined) {
        if (fresh.address.toLowerCase() === current.address.toLowerCase()) {
          // Still the connected account: keep it, and let the pages re-read what may have changed with it.
          notify();
        } else {
          adopt(fresh);
        }
        return;
      }
    }
    adopt(null);
  };

  const adopt = (next: AccountProvider | null): void => {
    detach?.();
    detach = null;
    account = next;
    if (next !== null) {
      detach = next.onChange((event) => {
        if (event === "accounts" || event === "disconnect") {
          // The wallet may have switched to another account, revoked access, or only restarted: read it again.
          void reread(next);
          return;
        }
        notify();
      });
    }
    notify();
  };

  for (const layer of layers) {
    layer.watch((connectors) => {
      lists.set(layer.id, connectors);
      notify();
    });
  }

  const ready = (async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, discoveryMs));
    const remembered = prefs.wallet.get();
    if (remembered === null) {
      return;
    }
    const layer = layerOf(remembered);
    if (layer === undefined) {
      return;
    }
    try {
      adopt(await layer.connect(remembered, { silent: true }));
    } catch {
      adopt(null);
    }
  })();

  return {
    account: () => account,
    connectors: () => layers.flatMap((layer) => lists.get(layer.id) ?? []),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async connect(connectorId, options = {}) {
      const layer = layerOf(connectorId);
      if (layer === undefined) {
        throw new Error(`no wallet ${connectorId}`);
      }
      const connected = await layer.connect(connectorId, { silent: false, ...(options.label === undefined ? {} : { label: options.label }) });
      if (connected === null) {
        throw new Error("the wallet shared no account");
      }
      prefs.wallet.set(connectorId);
      adopt(connected);
      return connected;
    },
    disconnect() {
      prefs.wallet.set(null);
      adopt(null);
    },
    ready,
  };
}
