// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's API end to end in process, for the spine's route tests: the real services (the reconciler's
 * engine, approvals and in-memory stores), the PayPal fake the factory builds in `fake` mode with its webhook deliveries
 * handed to the same app, Ethereum Sepolia with PayLinkV2 recorded at its CREATE2 address (a fixture deployment; the
 * shipped registry records the owner's), a chain reader the test switches between payable and paid, and links signed
 * with anvil keys. Sessions are stubbed (`payee`, `other`); the registry's RPC answers `eth_getCode` with "no code" and
 * nothing else.
 *
 * Owner: PayPal spine workstream.
 */
import type { ChainObservation } from "../../src/reconciler/types.ts";
import { createRegistry, ethereumSepolia, RELEASE } from "@paylink/chains";
import type { Registry } from "@paylink/chains";
import { issueInvoice } from "@paylink/sdk";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainReader } from "../../src/chain/types.ts";
import { createApp } from "../../src/core/app.ts";
import type { ApiServices } from "../../src/core/services.ts";
import { createServices } from "../../src/core/services.ts";
import { payPalFakeOf } from "../../src/paypal/factory.ts";
import type { PayPalFake } from "../../src/paypal/fake/index.ts";
import { createTwinHandlers } from "../../src/routes/twin.ts";
import { webhookHandlers } from "../../src/routes/webhook.ts";
import { createMemoryStores } from "../../src/store/memory.ts";
import { T0, testRuntime } from "../helpers.ts";

export const PAYEE = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const OTHER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
export const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const PYUSD = "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9";
export const PAGES = "https://paypal.paylink-mg.pages.dev/paypal/pay/";
/** Where the fake delivers webhooks: this app's route. */
export const HOOK_ORIGIN = "http://api.test";

/** The shipped Sepolia entry with a fixture deployment of PayLinkV2 at its release address (not the owner's record). */
export const DEPLOYED: Registry = createRegistry([
  {
    ...ethereumSepolia,
    deployment: {
      address: RELEASE.create2.address,
      status: "active",
      release: RELEASE.release,
      method: "CREATE2",
      deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      txHash: `0x${"de".repeat(32)}`,
      blockNumber: 11_959_000n,
      initCodeHash: RELEASE.initCodeHash,
      maskedRuntimeHash: RELEASE.maskedRuntimeHash,
      runtimeCodeHash: `0x${"00".repeat(32)}`,
    },
  },
]);

export interface LinkOptions {
  readonly amount?: bigint;
  readonly maxPayments?: number;
  readonly token?: `0x${string}`;
  readonly validUntil?: bigint;
  readonly memo?: string;
}

/** A signed PayLink invoice link of the payee's on Ethereum Sepolia (USDC, $120.00, one payment, a week). */
export async function link(options: LinkOptions = {}): Promise<{ readonly url: string; readonly key: `0x${string}` }> {
  const issued = await issueInvoice({
    registry: DEPLOYED,
    chainId: 11155111,
    signer: PAYEE,
    draft: {
      payee: PAYEE.address,
      token: options.token ?? USDC,
      amount: options.amount ?? 120_000_000n,
      maxPayments: options.maxPayments ?? 1,
      expiry: { kind: "at", validUntil: options.validUntil ?? BigInt(Math.floor(T0 / 1000) + 7 * 86_400) },
      memo: options.memo ?? "Logo design",
    },
    random: (n) => new Uint8Array(n).fill(options.amount === undefined ? 7 : Number(options.amount % 251n)),
  });
  return { url: `${PAGES}#${issued.fragment}`, key: issued.key };
}

export interface World {
  readonly app: ReturnType<typeof createApp>;
  readonly services: ApiServices;
  readonly fake: PayPalFake;
  readonly clock: { now: number };
  /** JSON-RPC methods the registry's RPC was asked. */
  readonly rpc: string[];
  /** What the chain reader answers for every key (payable until a test changes it). */
  chain: (now: number) => ChainObservation;
  post(body: unknown, token?: string): Promise<Response>;
  get(path: string, token?: string): Promise<Response>;
}

export function world(registry: Registry = DEPLOYED): World {
  const clock = { now: T0 };
  const rpc: string[] = [];
  let app: ReturnType<typeof createApp> | null = null;
  const base = testRuntime({ secrets: { approvalHmacKey: "11".repeat(32), sessionHmacKey: "22".repeat(32) } });
  const fetchStub: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith(`${HOOK_ORIGIN}/`) && app !== null) {
      return await app.request(new URL(request.url).pathname, { method: request.method, headers: request.headers, body: await request.text() });
    }
    const body = (await request.json()) as { id: number; method: string };
    rpc.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(body.method === "eth_getCode" ? { result: "0x" } : { error: { code: -32601, message: "not here" } }) }), { headers: { "Content-Type": "application/json" } });
  };
  const runtime = { ...base, clock: () => clock.now, fetch: fetchStub };
  const services0 = createServices(runtime, createMemoryStores());
  const state: Pick<World, "chain"> = { chain: (now) => ({ state: "payable", payments: [], paidAt: null, chainTime: Math.floor(now / 1000) }) };
  const chain: ChainReader = {
    chainId: 11155111,
    deployed: true,
    observe: () => Promise.resolve(state.chain(clock.now)),
    observeMany: (twins) => Promise.resolve(new Map(twins.map((t) => [t.key, state.chain(clock.now)]))),
  };
  const sessions = {
    ...services0.sessions,
    check: (token: string | null) =>
      Promise.resolve(token === "payee" ? { ok: true as const, payee: PAYEE.address, expiresAt: clock.now + 1 } : token === "other" ? { ok: true as const, payee: OTHER.address, expiresAt: clock.now + 1 } : { ok: false as const, reason: "bad-mac" as const }),
  };
  const services: ApiServices = { ...services0, chain, sessions };
  const fake = payPalFakeOf(services.paypal);
  if (fake === null) {
    throw new Error("expected the PayPal fake in fake mode");
  }
  fake.connect({ webhookUrl: `${HOOK_ORIGIN}/v1/paypal/webhook` });
  const built = createApp(services, [createTwinHandlers({ registry }), webhookHandlers]);
  app = built;
  return {
    app: built,
    services,
    fake,
    clock,
    rpc,
    get chain() {
      return state.chain;
    },
    set chain(answer) {
      state.chain = answer;
    },
    post: async (body, token = "payee") => await built.request("/v1/twin", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
    get: async (path, token) => await built.request(path, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  };
}
