// SPDX-License-Identifier: MIT
/**
 * Requester identities (audit finding A-04): the relayer counts strikes and relays per IPv4 address and per IPv6
 * /64, because one IPv6 subscriber holds a whole /64 and would otherwise get a fresh identity per request.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isPayLinkError, requesterFromIp } from "../src/index.ts";

describe("requesterFromIp", () => {
  it.each([
    ["203.0.113.7", "ip4:203.0.113.7"],
    [" 0.0.0.0 ", "ip4:0.0.0.0"],
    ["255.255.255.255", "ip4:255.255.255.255"],
    ["::ffff:203.0.113.7", "ip4:203.0.113.7"],
    ["::FFFF:cb00:7107", "ip4:203.0.113.7"],
    ["0:0:0:0:0:ffff:cb00:7107", "ip4:203.0.113.7"],
    ["2001:db8:1:2::1", "ip6:2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd", "ip6:2001:db8:1:2::/64"],
    ["2001:db8::", "ip6:2001:db8:0:0::/64"],
    ["::", "ip6:0:0:0:0::/64"],
    ["::1", "ip6:0:0:0:0::/64"],
    ["fe80::1:2:3:4", "ip6:fe80:0:0:0::/64"],
    ["64:ff9b::203.0.113.7", "ip6:64:ff9b:0:0::/64"],
    ["2001:db8:1:2:3:4:5::", "ip6:2001:db8:1:2::/64"],
  ])("maps %s to %s", (input, expected) => {
    expect(requesterFromIp(input)).toBe(expected);
  });

  it.each([
    "",
    "localhost",
    "203.0.113",
    "203.0.113.256",
    "203.0.113.07",
    "203.0.113.7.1",
    "2001:db8::1::2",
    "2001:db8:1:2:3:4:5:6:7",
    "2001:db8:1:2:3:4:5",
    "1:2:3:4:5:6:7::8",
    "2001:db8::g",
    "2001:db8::12345",
    "fe80::1%eth0",
    "[2001:db8::1]",
    "::ffff:203.0.113.256",
    "::203.0.113.7:1",
  ])("refuses %j", (input) => {
    let caught: unknown;
    try {
      requesterFromIp(input);
    } catch (error) {
      caught = error;
    }
    expect(isPayLinkError(caught, "E_INVALID_ARGUMENT")).toBe(true);
  });

  it("gives every address of one /64 the same identity, and different /64s different ones", () => {
    const group = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));
    fc.assert(
      fc.property(fc.array(group, { minLength: 4, maxLength: 4 }), fc.array(group, { minLength: 4, maxLength: 4 }), fc.array(group, { minLength: 4, maxLength: 4 }), (prefix, a, b) => {
        // Exclude the IPv4-mapped range, which is not a /64 of its own.
        fc.pre(!(prefix.every((g) => g === "0") && a[0] === "0" && a[1] === "ffff"));
        fc.pre(!(prefix.every((g) => g === "0") && b[0] === "0" && b[1] === "ffff"));
        expect(requesterFromIp([...prefix, ...a].join(":"))).toBe(requesterFromIp([...prefix, ...b].join(":")));
      }),
    );
    expect(requesterFromIp("2001:db8:1:2::1")).not.toBe(requesterFromIp("2001:db8:1:3::1"));
  });
});
