// SPDX-License-Identifier: MIT
/**
 * History reads within public-RPC limits (read/history.ts): the first block stamped at or after a time, found by
 * probing headers (equal stamps, irregular block times and a genesis inside the window included), and a log scan that
 * never asks for more blocks than the chain accepts, newest first, stopping at the first log it is looking for.
 */
import type { RpcLog } from "viem";
import { describe, expect, it } from "vitest";
import { blockAtTime, DEFAULT_LOG_RANGE, headBlock, logRange, scanLogs } from "../src/read/history.ts";
import { localChain } from "./helpers.ts";

/** A chain of `n` blocks whose stamps never decrease: runs of equal stamps, then gaps of up to 40 s. */
function chain(n: number, seed = 7): bigint[] {
  const stamps: bigint[] = [];
  let t = 1_700_000_000n;
  let x = seed;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2 ** 31;
    t += BigInt(x % 5 === 0 ? 0 : (x % 40) + 1);
    stamps.push(t);
  }
  return stamps;
}

function client(stamps: readonly bigint[]) {
  const probes: bigint[] = [];
  return {
    probes,
    getBlock: (p: { blockNumber: bigint } | { blockTag: "latest" | "finalized" }) => {
      const number = "blockNumber" in p ? p.blockNumber : BigInt(stamps.length - 1);
      probes.push(number);
      const timestamp = stamps[Number(number)];
      return timestamp === undefined ? Promise.reject(new Error(`no block ${String(number)}`)) : Promise.resolve({ number, timestamp });
    },
    getBlockNumber: () => Promise.resolve(BigInt(stamps.length - 1)),
    getLogs: () => Promise.resolve([] as RpcLog[]),
  };
}

const brute = (stamps: readonly bigint[], time: bigint): bigint => {
  const index = stamps.findIndex((s) => s >= time);
  return BigInt(index === -1 ? stamps.length : index);
};

describe("blockAtTime", () => {
  it("finds the first block stamped at or after any time, exactly, in a few header reads", async () => {
    const stamps = chain(20_000);
    const c = client(stamps);
    const head = await headBlock(c);
    const first = stamps[0] ?? 0n;
    const last = stamps.at(-1) ?? 0n;
    const times = [first - 10n, first, first + 1n, last, last + 1n, ...Array.from({ length: 60 }, (_, i) => first + ((last - first) * BigInt(i * 7 + 1)) / 421n)];
    for (const time of times) {
      c.probes.length = 0;
      expect(await blockAtTime(c, time, head), String(time)).toBe(brute(stamps, time));
      // Bracketing from the head, then interpolation with bisection: logarithmic, never a walk over blocks.
      expect(c.probes.length).toBeLessThanOrEqual(60);
    }
  });

  it("lands on the first of several blocks sharing a stamp, and needs few reads for a recent time", async () => {
    const stamps = [10n, 10n, 20n, 20n, 20n, 30n, ...Array.from({ length: 5_000 }, (_, i) => 31n + BigInt(i))];
    const c = client(stamps);
    const head = await headBlock(c);
    expect(await blockAtTime(c, 20n, head)).toBe(2n);
    expect(await blockAtTime(c, 11n, head)).toBe(2n);
    expect(await blockAtTime(c, 10n, head)).toBe(0n);
    c.probes.length = 0;
    // Ten minutes ago on a one-second chain: bracketed by the first probe.
    expect(await blockAtTime(c, (stamps.at(-1) ?? 0n) - 600n, head)).toBe(BigInt(stamps.length - 1 - 600));
    expect(c.probes.length).toBeLessThanOrEqual(14);
  });
});

describe("scanLogs", () => {
  const log = (block: bigint, tag: string): RpcLog => ({ blockNumber: `0x${block.toString(16)}`, data: tag }) as unknown as RpcLog;
  const tagOf = (l: RpcLog): string => l.data;

  it("asks for at most `range` blocks at a time, newest first, and stops at the first accepted log", async () => {
    const asked: [bigint, bigint][] = [];
    const logs = [log(120n, "old"), log(260n, "wanted"), log(290n, "newer, refused")];
    const c = {
      getLogs: (f: { fromBlock: bigint; toBlock: bigint }) => {
        asked.push([f.fromBlock, f.toBlock]);
        return Promise.resolve(logs.filter((l) => BigInt(l.blockNumber ?? "0x0") >= f.fromBlock && BigInt(l.blockNumber ?? "0x0") <= f.toBlock));
      },
    };
    const found = await scanLogs(c, { address: "0x0000000000000000000000000000000000000001", topics: [] }, { from: 100n, to: 399n, range: 100n }, (l) => Promise.resolve(tagOf(l) === "wanted" ? l.blockNumber : null));
    expect(found).toBe("0x104");
    expect(asked).toEqual([
      [300n, 399n],
      [200n, 299n],
    ]);
    asked.length = 0;
    expect(await scanLogs(c, { address: "0x0000000000000000000000000000000000000001", topics: [] }, { from: 0n, to: 250n, range: 100n }, () => Promise.resolve(null))).toBeNull();
    expect(asked).toEqual([
      [151n, 250n],
      [51n, 150n],
      [0n, 50n],
    ]);
  });

  it("uses the chain's own cap, or 100 blocks when it states none", () => {
    expect(logRange({ rpcLimits: { maxLogBlockRange: 100 } })).toBe(100n);
    expect(logRange({ rpcLimits: { maxLogBlockRange: 2_000 } })).toBe(2_000n);
    expect(logRange(localChain())).toBe(BigInt(DEFAULT_LOG_RANGE));
  });
});
