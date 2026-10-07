// SPDX-License-Identifier: MIT
/**
 * A mock EIP-1193 wallet announced through EIP-6963 (the v1 design-harness pattern, spec §4.2), and the network
 * routing that sends the registry's RPC URLs to local anvil chains.
 *
 * The wallet lives in Node: the page-side provider forwards every request through a Playwright binding, so it is not
 * subject to the page's CSP, exactly like a real extension. It signs nothing itself: eth_sendTransaction goes to
 * anvil, whose default accounts are unlocked. It knows only some chains at first, so `wallet_addEthereumChain` is
 * exercised, and it records every request for assertions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { jsonRpc } from "./anvil.ts";
import { WEB_ROOT } from "./server.ts";

export interface WalletRequest {
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface MockWalletOptions {
  readonly account: string;
  /** The chain the wallet is on when the page opens. */
  readonly chainId: number;
  /** Chains the wallet can reach: chain id → anvil URL (null: known to the wallet but not running). */
  readonly endpoints: ReadonlyMap<number, string | null>;
  /** Chains the wallet has configured already; others answer 4902 until added. */
  readonly known: readonly number[];
}

export interface MockWallet {
  readonly requests: WalletRequest[];
  chainId(): number;
  /** Answer the next request of `method` with an EIP-1193 error. */
  failNext(method: string, code: number, message: string): void;
  sent(): WalletRequest[];
}

type Answer = { result: unknown; events?: [string, unknown][] } | { error: { code: number; message: string } };

const hex = (n: number): string => `0x${n.toString(16)}`;

export async function installWallet(page: Page, options: MockWalletOptions): Promise<MockWallet> {
  let current = options.chainId;
  const known = new Set(options.known);
  const failures = new Map<string, { code: number; message: string }>();
  const requests: WalletRequest[] = [];

  const answer = async (method: string, params: readonly unknown[]): Promise<Answer> => {
    requests.push({ method, params });
    const failure = failures.get(method);
    if (failure !== undefined) {
      failures.delete(method);
      return { error: failure };
    }
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return { result: [options.account.toLowerCase()] };
      case "eth_chainId":
        return { result: hex(current) };
      case "wallet_switchEthereumChain": {
        const target = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
        if (!known.has(target)) {
          return { error: { code: 4902, message: `Unrecognized chain ID "${hex(target)}". Try adding the chain using wallet_addEthereumChain first.` } };
        }
        const changed = target !== current;
        current = target;
        return { result: null, ...(changed ? { events: [["chainChanged", hex(target)]] } : {}) };
      }
      case "wallet_addEthereumChain": {
        const target = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
        if (!options.endpoints.has(target)) {
          return { error: { code: -32603, message: "the test wallet cannot reach that chain" } };
        }
        known.add(target);
        current = target;
        return { result: null, events: [["chainChanged", hex(target)]] };
      }
      default: {
        const url = options.endpoints.get(current) ?? null;
        if (url === null) {
          return { error: { code: 4901, message: `the test wallet is not connected to chain ${String(current)}` } };
        }
        try {
          if (method === "eth_sendTransaction") {
            const tx = params[0] as { from: string };
            if (tx.from.toLowerCase() !== options.account.toLowerCase()) {
              return { error: { code: 4100, message: "unauthorized account" } };
            }
          }
          return { result: await jsonRpc(url, method, params) };
        } catch (error) {
          const e = error as { code?: number; message: string };
          return { error: { code: e.code ?? -32603, message: e.message } };
        }
      }
    }
  };
  await page.exposeFunction("__paylinkTestWallet", answer);
  await page.addInitScript(
    ({ name }) => {
      const listeners = new Map<string, Set<(arg: unknown) => void>>();
      const bridge = (window as unknown as { __paylinkTestWallet: (m: string, p: unknown[]) => Promise<Answer> }).__paylinkTestWallet;
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
          const reply = await bridge(method, params ?? []);
          if ("error" in reply) {
            throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
          }
          for (const [event, arg] of reply.events ?? []) {
            setTimeout(() => {
              for (const fn of listeners.get(event) ?? []) {
                fn(arg);
              }
            }, 0);
          }
          return reply.result;
        },
        on(event: string, fn: (arg: unknown) => void): void {
          listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
        },
        removeListener(event: string, fn: (arg: unknown) => void): void {
          listeners.get(event)?.delete(fn);
        },
      };
      const info = Object.freeze({
        uuid: "6f4c8f7e-4f61-4c6f-9b9e-7061796c696e",
        name,
        icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23161615'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23FF5A1F'/%3E%3C/svg%3E",
        rdns: "dev.paylink.testwallet",
      });
      const announce = (): void => {
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
      };
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    { name: "PayLink Test Wallet" },
  );
  return {
    requests,
    chainId: () => current,
    failNext: (method, code, message) => {
      failures.set(method, { code, message });
    },
    sent: () => requests.filter((r) => r.method === "eth_sendTransaction"),
  };
}

interface ChainsFile {
  readonly chains: readonly { readonly chainId: number; readonly rpc: readonly string[] }[];
}

/** The registry RPCs of the deploy targets, from the page's own data. */
export function registryRpcs(): ReadonlyMap<number, readonly string[]> {
  const data = JSON.parse(readFileSync(join(WEB_ROOT, "v2/deploy/data/chains.json"), "utf8")) as ChainsFile;
  return new Map(data.chains.map((c) => [c.chainId, c.rpc]));
}

/**
 * Sends the page's requests to the registry RPCs (https://testnet-rpc.monad.xyz, …) to the anvil running that chain,
 * with the CORS answers a public RPC gives. Chains without an anvil fail like an unreachable endpoint. Returns the
 * log of forwarded JSON-RPC methods.
 */
export async function routeRegistry(context: BrowserContext, anvils: ReadonlyMap<number, string>): Promise<{ method: string; chainId: number }[]> {
  const log: { method: string; chainId: number }[] = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
  for (const [chainId, urls] of registryRpcs()) {
    for (const url of urls) {
      await context.route(`${new URL(url).origin}/**`, async (route: Route) => {
        const request = route.request();
        if (request.method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers: cors });
          return;
        }
        const anvil = anvils.get(chainId);
        if (anvil === undefined) {
          await route.abort("connectionrefused");
          return;
        }
        const body = request.postData() ?? "{}";
        log.push({ method: (JSON.parse(body) as { method: string }).method, chainId });
        const response = await fetch(anvil, { method: "POST", headers: { "content-type": "application/json" }, body });
        await route.fulfill({ status: response.status, headers: { ...cors, "content-type": "application/json" }, body: await response.text() });
      });
    }
  }
  return log;
}
