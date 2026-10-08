// SPDX-License-Identifier: MIT
/** Small concurrency and rate primitives for the ChainSender. */

/**
 * Token buckets keyed by requester, plus one for the whole chain. In memory only: losing them on a restart lets a
 * requester through early, which the persisted admission ledger and daily caps still bound. Keeping them out of
 * storage keeps requester identities out of storage too.
 */
export class RequestLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly chain: { tokens: number; at: number };
  private readonly perRequesterPerMinute: number;
  private readonly perChainPerMinute: number;

  constructor(perRequesterPerMinute: number, perChainPerMinute: number, nowMs: number) {
    this.perRequesterPerMinute = perRequesterPerMinute;
    this.perChainPerMinute = perChainPerMinute;
    this.chain = { tokens: perChainPerMinute, at: nowMs };
  }

  /** Takes one request; returns `null` when allowed, else the seconds until a token is available. */
  take(requester: string, nowMs: number): number | null {
    if (this.perRequesterPerMinute <= 0 || this.perChainPerMinute <= 0) {
      return 60;
    }
    const refill = (bucket: { tokens: number; at: number }, capacity: number): void => {
      const elapsed = Math.max(0, nowMs - bucket.at);
      bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * capacity) / 60_000);
      bucket.at = nowMs;
    };
    refill(this.chain, this.perChainPerMinute);
    let bucket = this.buckets.get(requester);
    if (bucket === undefined) {
      if (this.buckets.size >= 10_000) {
        // Bound memory under a spray of identities: forget the least recently seen.
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) {
          this.buckets.delete(oldest);
        }
      }
      bucket = { tokens: this.perRequesterPerMinute, at: nowMs };
    } else {
      this.buckets.delete(requester); // re-insert: Map order is recency order
      refill(bucket, this.perRequesterPerMinute);
    }
    this.buckets.set(requester, bucket);
    const wait = (b: { tokens: number }, capacity: number): number => Math.max(1, Math.ceil(((1 - b.tokens) * 60) / capacity));
    if (bucket.tokens < 1) {
      return wait(bucket, this.perRequesterPerMinute);
    }
    if (this.chain.tokens < 1) {
      return wait(this.chain, this.perChainPerMinute);
    }
    bucket.tokens -= 1;
    this.chain.tokens -= 1;
    return null;
  }
}

/** Runs tasks one at a time, in call order (the nonce critical section and the tracker). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
