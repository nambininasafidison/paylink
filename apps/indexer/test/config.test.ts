// SPDX-License-Identifier: MIT
/**
 * config.yaml against the repository's sources of truth, read through Envio's own parser (the test indexer exposes
 * the parsed chains, addresses, start blocks and the ABI it derived from the event signatures):
 * - protocol/deployments/<chainId>.json: canonical address and deployment block of every indexed chain;
 * - the release ABI (packages/sdk/src/generated/paylink-v2-abi.ts, generated from the forge artifact): both events;
 * - web/v2/deploy/data/chains.json (generated from @paylink/chains): the fallback RPCs are registry RPCs.
 */
import { readFileSync } from "node:fs";
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { payLinkV2Abi } from "../../../packages/sdk/src/generated/paylink-v2-abi.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

interface DeploymentRecord {
  readonly chainId: number;
  readonly address: string;
  readonly deployment: { readonly blockNumber: number };
}
const record = (chainId: number): DeploymentRecord => JSON.parse(read(`protocol/deployments/${String(chainId)}.json`)) as DeploymentRecord;

const INDEXED = [10143, 84532] as const;

describe("config.yaml", () => {
  const indexer = createTestIndexer();

  it("indexes exactly the chains that have a PayLinkV2 deployment record here", () => {
    expect([...indexer.chainIds].sort()).toEqual([...INDEXED]);
  });

  it.each(INDEXED)("chain %i: canonical address and deployment block from protocol/deployments", (chainId) => {
    const chain = indexer.chains[chainId];
    const deployment = record(chainId);
    expect(deployment.chainId).toBe(chainId);
    expect(chain.PayLinkV2.addresses).toEqual([deployment.address.toLowerCase()]);
    expect(chain.startBlock).toBe(deployment.deployment.blockNumber);
    expect(chain.endBlock).toBeUndefined();
  });

  it("decodes Paid and InvoiceCancelled exactly as the release ABI declares them", () => {
    const shape = (entry: { readonly name?: string; readonly inputs?: readonly { readonly name: string; readonly type: string; readonly indexed?: boolean }[] }) => ({
      name: entry.name,
      inputs: (entry.inputs ?? []).map((input) => ({ name: input.name, type: input.type, indexed: input.indexed === true })),
    });
    const release = payLinkV2Abi.filter((entry) => entry.type === "event" && (entry.name === "Paid" || entry.name === "InvoiceCancelled")).map(shape);
    expect(release).toHaveLength(2);
    for (const chainId of INDEXED) {
      const parsed = (indexer.chains[chainId].PayLinkV2.abi as readonly Parameters<typeof shape>[0][]).map(shape);
      expect([...parsed].sort((a, b) => String(a.name).localeCompare(String(b.name)))).toEqual([...release].sort((a, b) => String(a.name).localeCompare(String(b.name))));
    }
  });

  it("falls back only to registry RPCs, within Monad's 100-block log cap", () => {
    const yaml = read("apps/indexer/config.yaml");
    const registry = (JSON.parse(read("web/v2/deploy/data/chains.json")) as { chains: { chainId: number; rpc: string[] }[] }).chains;
    const blocks = yaml.split(/^ {2}- id: /m).slice(1);
    expect(blocks).toHaveLength(INDEXED.length);
    for (const block of blocks) {
      const chainId = Number(/^(\d+)/.exec(block)?.[1]);
      const urls = [...block.matchAll(/^ {6}- url: (\S+)$/gm)].map((m) => m[1]);
      expect(urls.length).toBeGreaterThan(0);
      const known = registry.find((c) => c.chainId === chainId)?.rpc ?? [];
      for (const url of urls) {
        expect(known).toContain(url);
      }
      if (chainId === 10143) {
        // packages/chains: monadTestnet.rpcLimits.maxLogBlockRange = 100.
        expect(block).toMatch(/^ {8}interval_ceiling: 100$/m);
      }
    }
  });

  it("keeps no secret in the file: HyperSync's token comes from the environment of the deployment", () => {
    const yaml = read("apps/indexer/config.yaml");
    expect(yaml).not.toMatch(/api[_-]?token|apikey|bearer|authorization|headers:/i);
  });
});
