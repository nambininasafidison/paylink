// SPDX-License-Identifier: MIT
/**
 * A test wallet announced through EIP-6963 for the demo recordings, like fixtures/wallet.ts, but holding a real
 * private key in Node: it signs typed data, messages and transactions itself (viem local account) and sends raw
 * transactions to the RPC it is given (the real Ethereum Sepolia, or an anvil fork of it). The key is read from a
 * `cast wallet new --json` file and never leaves this module: nothing logs it, and the page only ever sees the provider.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { createWalletClient, http, publicActions } from "viem";
import type { Hex, TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export interface KeyWallet {
  readonly address: Hex;
  /** Methods the page asked for, in order (no parameters: they may carry nothing secret, but stay small). */
  readonly asked: string[];
  /** Transaction hashes this wallet sent. */
  readonly sent: Hex[];
}

type Answer = { result: unknown } | { error: { code: number; message: string } };

/** Reads the key of a `cast wallet new --json` file: `{ data: [{ address, private_key }] }` or `[{ ... }]`. */
function keyOf(file: string): Hex {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { data?: { private_key: string }[] } | { private_key: string }[];
  const entry = Array.isArray(parsed) ? parsed[0] : parsed.data?.[0];
  if (entry === undefined) {
    throw new Error(`no key in ${file}`);
  }
  return entry.private_key as Hex;
}

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (body.error !== undefined) {
    throw Object.assign(new Error(body.error.message), { code: body.error.code });
  }
  return body.result;
}

export async function installKeyWallet(page: Page, keyFile: string, rpcUrl: string, info = { name: "Test Wallet", rdns: "dev.paylink.testwallet" }): Promise<KeyWallet> {
  const account = privateKeyToAccount(keyOf(keyFile));
  const client = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) }).extend(publicActions);
  const me = account.address.toLowerCase();
  const wallet: KeyWallet = { address: account.address, asked: [], sent: [] };

  const answer = async (method: string, params: readonly unknown[]): Promise<Answer> => {
    wallet.asked.push(method);
    try {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return { result: [me] };
        case "eth_chainId":
          return { result: `0x${sepolia.id.toString(16)}` };
        case "net_version":
          return { result: String(sepolia.id) };
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": {
          const target = Number.parseInt((params[0] as { chainId: string }).chainId, 16);
          return target === sepolia.id ? { result: null } : { error: { code: 4902, message: "the test wallet only knows Ethereum Sepolia" } };
        }
        case "wallet_getCapabilities":
        case "wallet_sendCalls":
        case "wallet_getCallsStatus":
          return { error: { code: 4200, message: `${method} is not supported` } };
        case "eth_signTypedData_v4": {
          const [from, data] = params as [string, string | object];
          if (from.toLowerCase() !== me) {
            return { error: { code: 4100, message: "unauthorized account" } };
          }
          const typed = (typeof data === "string" ? JSON.parse(data) : data) as TypedDataDefinition & { types: Record<string, unknown> };
          const { EIP712Domain: _domain, ...types } = typed.types;
          return { result: await account.signTypedData({ ...typed, types } as TypedDataDefinition) };
        }
        case "personal_sign": {
          const [message, from] = params as [Hex, string];
          if (from.toLowerCase() !== me) {
            return { error: { code: 4100, message: "unauthorized account" } };
          }
          return { result: await account.signMessage({ message: { raw: message } }) };
        }
        case "eth_sendTransaction": {
          const tx = params[0] as { from: string; to: Hex; data?: Hex; value?: Hex; gas?: Hex };
          if (tx.from.toLowerCase() !== me) {
            return { error: { code: 4100, message: "unauthorized account" } };
          }
          const hash = await client.sendTransaction({ to: tx.to, data: tx.data, value: tx.value === undefined ? undefined : BigInt(tx.value), ...(tx.gas === undefined ? {} : { gas: BigInt(tx.gas) }) });
          wallet.sent.push(hash);
          return { result: hash };
        }
        default:
          return { result: await rpc(rpcUrl, method, params) };
      }
    } catch (error) {
      const e = error as { code?: number; shortMessage?: string; message: string };
      return { error: { code: e.code ?? -32603, message: e.shortMessage ?? e.message.split("\n")[0] ?? "error" } };
    }
  };
  await page.exposeFunction("__paylinkKeyWallet", answer);
  await page.addInitScript(
    ({ name, rdns }) => {
      const listeners = new Map<string, Set<(arg: unknown) => void>>();
      const bridge = (window as unknown as { __paylinkKeyWallet: (m: string, p: unknown[]) => Promise<Answer> }).__paylinkKeyWallet;
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
          const reply = await bridge(method, params ?? []);
          if ("error" in reply) {
            throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
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
      const detail = Object.freeze({
        info: Object.freeze({
          uuid: "0f6a1d52-7a43-4c1e-9a55-766964656f31",
          name,
          icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23161615'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23FF5A1F'/%3E%3C/svg%3E",
          rdns,
        }),
        provider,
      });
      const announce = (): void => {
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      };
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    info,
  );
  return wallet;
}
