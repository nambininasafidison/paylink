// SPDX-License-Identifier: MIT
/**
 * Deterministic identifiers for the PayPal fake: the same seed gives the same invoice, payment, event and transmission
 * ids, so tests and recorded e2e runs are reproducible. Shapes follow what PayPal's ids look like where the OpenAPI
 * files bound them (invoice id ≤ 30, payment id ≤ 22 and `^[0-9A-Za-z_-]+$`, webhook id `^[a-zA-Z0-9]+$` ≤ 50, V); the
 * exact formats of real ids (`INV2-…`, `EXTR-…`, `WH-…`) are PayPal's habits seen in documentation (S), not contracts,
 * and nothing in PayLink depends on them.
 *
 * Owner: PayPal spine workstream.
 */

const UPPER_ALNUM = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const HEX = "0123456789abcdef";

/** mulberry32: a small seeded generator (not cryptographic: the fake's ids only need to be distinct and stable). */
export class FakeIds {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  private next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private chars(length: number, alphabet: string): string {
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += alphabet[Math.floor(this.next() * alphabet.length)] ?? "0";
    }
    return out;
  }

  /** `INV2-XXXX-XXXX-XXXX-XXXX` (24 characters). */
  invoiceId(): string {
    return `INV2-${[0, 1, 2, 3].map(() => this.chars(4, UPPER_ALNUM)).join("-")}`;
  }

  /** A PayPal payer payment id: 17 upper-case alphanumerics. */
  paypalPaymentId(): string {
    return this.chars(17, UPPER_ALNUM);
  }

  /** An external payment id: `EXTR-` + 17 (22 characters, the schema's maximum). */
  externalPaymentId(): string {
    return `EXTR-${this.chars(17, UPPER_ALNUM)}`;
  }

  /** A webhook subscription id: 17 upper-case alphanumerics. */
  webhookId(): string {
    return this.chars(17, UPPER_ALNUM);
  }

  /** `WH-<17>-<17>`. */
  eventId(): string {
    return `WH-${this.chars(17, UPPER_ALNUM)}-${this.chars(17, UPPER_ALNUM)}`;
  }

  /** A UUID-shaped transmission id. */
  transmissionId(): string {
    return [8, 4, 4, 4, 12].map((n) => this.chars(n, HEX)).join("-");
  }

  /** A debug id: 13 hex digits. */
  debugId(): string {
    return this.chars(13, HEX);
  }

  /** An access token (opaque to the client). */
  accessToken(): string {
    return `A21AA${this.chars(40, `${UPPER_ALNUM}abcdefghijkmnopqrstuvwxyz-_`)}`;
  }
}
