// SPDX-License-Identifier: MIT
/**
 * Node adapter: the relayer's HTTP app and ChainSenders in one Node process, for e2e tests and local demo recording
 * against anvil (PAYLINK-V2-SPEC §4.2 "the relayer through its Node adapter"). Same app, same engine, same policy
 * as the Worker; only the host differs: memory instead of Durable Object storage, timers instead of alarms, the
 * socket's address instead of `CF-Connecting-IP`.
 *
 * Safety: by default it serves **local chains only** (`ChainDefinition.local`, anvil on 127.0.0.1), and it listens
 * on 127.0.0.1. The key comes from the caller (anvil's public test keys in tests), never from a file in the repo.
 */
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import type { Registry } from "@paylink/chains";
import type { Transport } from "viem";
import { createApp } from "../core/app.ts";
import { relayRegistry } from "../core/chains.ts";
import { chainClient } from "../core/client.ts";
import { ChainEngine } from "../core/engine.ts";
import type { Logger } from "../core/log.ts";
import { createLogger } from "../core/log.ts";
import { originPolicy } from "../core/origins.ts";
import type { RelayerPolicy } from "../core/policy.ts";
import { memoryStore } from "../core/state.ts";
import { RELAYER_VERSION } from "../core/version.ts";

export interface NodeRelayerOptions {
  /** Chains to serve. Without `allowRemoteChains`, only local (anvil) chains are kept. */
  readonly registry: Registry;
  /** The relayer key (an anvil test key). */
  readonly privateKey: string;
  readonly host?: string;
  /** 0 picks a free port. */
  readonly port?: number;
  /** Exact origins allowed besides the production ones (the local web server of an e2e run). */
  readonly allowedOrigins?: readonly string[];
  readonly policy?: RelayerPolicy;
  /** Milliseconds since the epoch, for the engines (tests drive replacement timing with it). */
  readonly clock?: () => number;
  /** A transport per chain id instead of the registry's RPCs (tests). */
  readonly transport?: (chainId: number) => Transport | undefined;
  /** Log sink; silent by default. */
  readonly log?: (line: string) => void;
  /** Serve non-local testnets too. Never needed for e2e; a guard against running a real key locally by accident. */
  readonly allowRemoteChains?: boolean;
  /** Run the tracker on timers (default true). Tests may turn it off and call `tick` themselves. */
  readonly autoTrack?: boolean;
}

export interface NodeRelayer {
  readonly url: string;
  /** The engine of a chain (created on first use). */
  engine(chainId: number): Promise<ChainEngine>;
  /** One tracker pass on every open chain. */
  tick(): Promise<void>;
  close(): Promise<void>;
}

export async function startNodeRelayer(options: NodeRelayerOptions): Promise<NodeRelayer> {
  const chains = relayRegistry(options.registry, { allowLocal: true });
  if (options.allowRemoteChains !== true && chains.chains.some((chain) => !chain.local)) {
    throw new Error("the Node adapter serves local chains only; pass allowRemoteChains to override");
  }
  const sink = options.log ?? ((): void => undefined);
  const logger: Logger = createLogger({ sink, secrets: [options.privateKey], base: { service: "paylink-relayer", version: RELAYER_VERSION, host: "node" } });
  const engines = new Map<number, Promise<ChainEngine>>();
  const timers = new Map<number, NodeJS.Timeout>();
  let closed = false;
  const autoTrack = options.autoTrack ?? true;

  const engine = (chainId: number): Promise<ChainEngine> => {
    let opened = engines.get(chainId);
    if (opened === undefined) {
      const chain = chains.getOrThrow(chainId);
      opened = ChainEngine.open({
        registry: chains,
        chainId,
        privateKey: options.privateKey,
        client: chainClient(chain, options.transport?.(chainId)),
        store: memoryStore(),
        allowLocal: true,
        logger,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        wake: (atMs) => {
          if (!autoTrack || closed) {
            return;
          }
          const delay = Math.max(0, atMs - Date.now());
          clearTimeout(timers.get(chainId));
          timers.set(
            chainId,
            setTimeout(() => {
              void engine(chainId).then(async (opened) => await opened.tick());
            }, delay).unref(),
          );
        },
      });
      engines.set(chainId, opened);
    }
    return opened;
  };

  const app = createApp<HttpBindings>({
    registry: chains,
    origins: originPolicy(options.allowedOrigins ?? []),
    gateway: () => ({
      relay: async (chainId, operation, input) => await (await engine(chainId))[operation](input),
      status: async (chainId) => await (await engine(chainId)).status(),
    }),
    // The socket's peer: the Node adapter is never behind a proxy, so no forwarding header is trusted.
    clientIp: (c) => c.env.incoming.socket.remoteAddress,
    logger,
    version: RELAYER_VERSION,
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, hostname: options.host ?? "127.0.0.1", port: options.port ?? 0 }, () => {
      resolve(started);
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;

  return {
    url: `http://${host}:${String(address.port)}`,
    engine,
    tick: async () => {
      for (const opened of engines.values()) {
        await (await opened).tick();
      }
    },
    close: async () => {
      closed = true;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}
