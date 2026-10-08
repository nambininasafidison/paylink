// SPDX-License-Identifier: MIT
/**
 * Cloudflare Worker entry (ADR 0007): the stateless front (`fetch`: CORS, schemas, routing) and one Durable Object
 * `ChainSender` per chain id, which owns the chain's nonce, send queue, replacements, counters, admission ledger
 * and daily gas budget.
 *
 * Secrets: `RELAYER_PK` comes only from the Worker secret of that name (dashboard: Settings → Variables and
 * Secrets). It is read inside the Durable Object, parsed once and never logged; deploy/wrangler.toml declares no
 * variable of that name, and test/unit/deploy.test.ts keeps it so.
 */
import { DurableObject } from "cloudflare:workers";
import type { ChainStatus, EngineResult, RelayInput } from "../core/engine.ts";
import { ChainEngine } from "../core/engine.ts";
import { createApp } from "../core/app.ts";
import { relayRegistry } from "../core/chains.ts";
import { chainClient } from "../core/client.ts";
import { createLogger } from "../core/log.ts";
import { originPolicy } from "../core/origins.ts";
import type { Operation } from "../core/schemas.ts";
import type { SenderState, StateStore } from "../core/state.ts";
import { RELAYER_VERSION } from "../core/version.ts";
import { allowLocal, source } from "./registry.ts";

export interface Env {
  readonly CHAIN_SENDER: DurableObjectNamespace<ChainSender>;
  /** Worker secret: the relayer's throwaway testnet key. Never a `[vars]` entry. */
  readonly RELAYER_PK?: string;
}

/** The chains this Worker relays: enabled v2 testnets of the shipped registry (no local chain, never a mainnet). */
const RELAY_REGISTRY = relayRegistry(source, { allowLocal });

// Workers Logs collects console output; the logger serialises one JSON object per line.
const sink = (line: string): void => {
  // eslint-disable-next-line no-console -- the platform's log sink
  console.log(line);
};

export class ChainSender extends DurableObject<Env> {
  private engine: Promise<ChainEngine> | null = null;

  /** Relays one validated request (`POST /v1/{chainId}/{operation}`). */
  async relay(chainId: number, operation: Operation, input: RelayInput): Promise<EngineResult> {
    const engine = await this.engineFor(chainId);
    return await engine[operation](input);
  }

  async status(chainId: number): Promise<ChainStatus> {
    return await (await this.engineFor(chainId)).status();
  }

  override async alarm(): Promise<void> {
    const chainId = await this.ctx.storage.get<number>("chainId");
    if (chainId !== undefined) {
      await (await this.engineFor(chainId)).tick();
    }
  }

  private engineFor(chainId: number): Promise<ChainEngine> {
    this.engine ??= this.open(chainId);
    return this.engine.then((engine) => {
      if (engine.chain.chainId !== chainId) {
        throw new Error(`this ChainSender serves chain ${String(engine.chain.chainId)}, not ${String(chainId)}`);
      }
      return engine;
    });
  }

  private async open(chainId: number): Promise<ChainEngine> {
    const chain = RELAY_REGISTRY.get(chainId);
    if (chain === undefined) {
      throw new Error(`chain ${String(chainId)} is not relayable`);
    }
    const storage = this.ctx.storage;
    await storage.put("chainId", chainId);
    const store: StateStore = {
      load: async () => await storage.get("state"),
      save: async (state: SenderState) => {
        await storage.put("state", state);
      },
    };
    const secret = this.env.RELAYER_PK;
    try {
      return await ChainEngine.open({
        registry: RELAY_REGISTRY,
        chainId,
        allowLocal,
        privateKey: secret,
        client: chainClient(chain),
        store,
        logger: createLogger({ sink, secrets: secret === undefined ? [] : [secret], base: { service: "paylink-relayer", version: RELAYER_VERSION } }),
        wake: async (atMs) => {
          const current = await storage.getAlarm();
          if (current === null || current > atMs) {
            await storage.setAlarm(atMs);
          }
        },
      });
    } catch (error) {
      this.engine = null; // let the next request retry the load
      throw error;
    }
  }
}

const app = createApp<Env>({
  registry: RELAY_REGISTRY,
  origins: originPolicy(),
  gateway: (env) => {
    const stub = (chainId: number) => env.CHAIN_SENDER.get(env.CHAIN_SENDER.idFromName(`chain:${String(chainId)}`));
    return {
      relay: async (chainId, operation, input) => await stub(chainId).relay(chainId, operation, input),
      status: async (chainId) => await stub(chainId).status(chainId),
    };
  },
  // Set by Cloudflare's edge on every request; clients cannot forge it.
  clientIp: (c) => c.req.header("cf-connecting-ip"),
  logger: createLogger({ sink, base: { service: "paylink-relayer", version: RELAYER_VERSION } }),
  version: RELAYER_VERSION,
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
