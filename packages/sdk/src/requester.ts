// SPDX-License-Identifier: MIT
/**
 * Requester identities for the relayer's admission policy (invoice spec §13.3; audit finding A-04).
 *
 * The relayer counts strikes and relays per requester, the party that sent the HTTP request. A plain client IP is
 * the wrong unit for IPv6: one subscriber, one VPS or one phone usually holds a whole /64 (2^64 addresses), so
 * counting per address would hand an attacker a fresh identity per request. `requesterFromIp` therefore maps an
 * IPv6 address to its /64 prefix and an IPv4 address (including the IPv4-mapped form `::ffff:a.b.c.d`) to itself.
 * The result is a branded string, so the ledger cannot be fed an unnormalised address by mistake.
 */
import { PayLinkError } from "./errors.ts";

declare const requesterBrand: unique symbol;

/** A normalised requester identity: `ip4:<dotted quad>` or `ip6:<first four groups>::/64`. Build it with `requesterFromIp`. */
export type RequesterId = string & { readonly [requesterBrand]: "RequesterId" };

const invalid = (address: string): never => {
  throw new PayLinkError("E_INVALID_ARGUMENT", `not an IP address: ${JSON.stringify(address.slice(0, 64))}`, { rule: "RequesterAddress" });
};

/** Four decimal octets without leading zeros (a leading zero reads as octal in some parsers), or `null`. */
function parseIpv4(text: string): readonly number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9][0-9]{0,2})$/u.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Eight 16-bit groups, `::` expanded and a trailing dotted quad folded into the last two, or `null`. */
function parseIpv6(text: string): readonly number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const groupsOf = (half: string | undefined): number[] | null => {
    if (half === undefined || half === "") {
      return [];
    }
    const groups: number[] = [];
    const parts = half.split(":");
    for (const [i, part] of parts.entries()) {
      if (i === parts.length - 1 && part.includes(".")) {
        const quad = parseIpv4(part);
        if (quad === null) {
          return null;
        }
        const [a = 0, b = 0, c = 0, d = 0] = quad;
        groups.push(a * 256 + b, c * 256 + d);
      } else if (/^[0-9a-f]{1,4}$/iu.test(part)) {
        groups.push(Number.parseInt(part, 16));
      } else {
        return null;
      }
    }
    return groups;
  };
  const head = groupsOf(halves[0]);
  const tail = groupsOf(halves[1]);
  if (head === null || tail === null) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...tail] : null;
}

/**
 * The requester identity of a client IP address, as the relayer's front end reports it (for example Cloudflare's
 * `CF-Connecting-IP`): IPv4 addresses as themselves, IPv4-mapped IPv6 addresses as their IPv4 address, and every
 * other IPv6 address as its /64 prefix. Throws `E_INVALID_ARGUMENT` (rule `RequesterAddress`) for anything else,
 * including zone indices and bracketed forms.
 */
export function requesterFromIp(address: string): RequesterId {
  const text = address.trim();
  const v4 = parseIpv4(text);
  if (v4 !== null) {
    return `ip4:${v4.join(".")}` as RequesterId;
  }
  const v6 = text.includes(":") ? parseIpv6(text) : null;
  if (v6 === null) {
    return invalid(address);
  }
  const mapped = v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff;
  if (mapped) {
    const [high = 0, low = 0] = v6.slice(6);
    return `ip4:${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}` as RequesterId;
  }
  return `ip6:${v6
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64` as RequesterId;
}
