// SPDX-License-Identifier: MIT
/**
 * web/v2/deploy/lib/eip7702.js: the authorization signing hash and the authority recovery the verifier uses to name the
 * account behind a relayed deployment, checked against viem (hashAuthorization, signAuthorization,
 * recoverAuthorizationAddress) and against the real Base Sepolia deployment's authorization.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashAuthorization, recoverAuthorizationAddress } from "viem/utils";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { authorizationAuthority, authorizationHash, delegationOf, recoverSigner } from "../../../web/v2/deploy/lib/eip7702.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DELEGATE: Address = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";

/** The authorization of tx 0x2969…b5ed on Base Sepolia (MetaMask smart account), as sepolia.base.org returns it. */
const BASE_SEPOLIA = {
  chainId: 84532n,
  address: DELEGATE,
  nonce: 0n,
  yParity: 0,
  r: 0x3fca8aff26ea0f1251afc940e234c777342b93fcfb4a5d51c728bfea7715b09n,
  s: 0x228ddefc70eddfdf68e5d2b444012c605ee2c52ed14e0ea712f0659c9a4fbbc7n,
};

describe("authorizationHash", () => {
  it.each([
    [0n, 0n],
    [1n, 1n],
    [84532n, 0n],
    [10143n, 127n],
    [421614n, 128n],
    [2n ** 64n - 2n, 2n ** 64n - 2n],
    // A 32-byte chain id makes the RLP list longer than 55 bytes (long-list prefix).
    [2n ** 256n - 1n, 255n],
  ])("is keccak256(0x05 ‖ rlp([%s, address, %s])) as viem computes it", (chainId, nonce) => {
    // viem types chainId and nonce as numbers but encodes them with numberToHex, which takes bigints as well.
    const viem = hashAuthorization({ chainId: chainId as unknown as number, address: DELEGATE, nonce: nonce as unknown as number });
    expect(authorizationHash({ chainId, address: DELEGATE, nonce })).toBe(viem);
  });

  it("hashes the Base Sepolia authorization as viem does", () => {
    expect(authorizationHash(BASE_SEPOLIA)).toBe("0xd45eefe422ebf7bf289d4f58dd73a5a256303dfedb2dbb7e8ecb43bda67bed44");
    expect(authorizationHash(BASE_SEPOLIA)).toBe(hashAuthorization({ chainId: 84532, address: DELEGATE, nonce: 0 }));
  });
});

describe("authorizationAuthority", () => {
  it("recovers the signer of random authorizations exactly as viem does", async () => {
    for (let i = 0; i < 12; i += 1) {
      const account = privateKeyToAccount(generatePrivateKey());
      const chainId = [0, 84532, 10143, 421614][i % 4] ?? 0;
      const signed = await account.signAuthorization({ chainId, address: DELEGATE, nonce: i * 37 });
      const tuple = { chainId: BigInt(chainId), address: DELEGATE, nonce: BigInt(i * 37), yParity: signed.yParity ?? 0, r: BigInt(signed.r), s: BigInt(signed.s) };
      expect(authorizationAuthority(tuple, 84532)).toBe(chainId === 0 || chainId === 84532 ? account.address : null);
      expect(recoverSigner(authorizationHash(tuple), tuple)).toBe(account.address);
      expect(await recoverAuthorizationAddress({ authorization: signed })).toBe(account.address);
    }
  });

  it("names the user's account behind the Base Sepolia deployment", () => {
    expect(authorizationAuthority(BASE_SEPOLIA, 84532)).toBe("0x0c397c6c8F94EAA6662eE548fA140e6DfEd4aea6");
  });

  it("skips what the protocol skips: another chain, nonce 2^64 − 1, high s, bad r or parity", () => {
    expect(authorizationAuthority(BASE_SEPOLIA, 10143)).toBeNull();
    expect(authorizationAuthority({ ...BASE_SEPOLIA, nonce: 2n ** 64n - 1n }, 84532)).toBeNull();
    // (r, n − s, 1 − v) is the same signature in its high-s form: EIP-2 and EIP-7702 refuse it.
    expect(authorizationAuthority({ ...BASE_SEPOLIA, s: N - BASE_SEPOLIA.s, yParity: 1 }, 84532)).toBeNull();
    expect(authorizationAuthority({ ...BASE_SEPOLIA, r: 0n }, 84532)).toBeNull();
    expect(authorizationAuthority({ ...BASE_SEPOLIA, r: N }, 84532)).toBeNull();
    expect(authorizationAuthority({ ...BASE_SEPOLIA, yParity: 2 }, 84532)).toBeNull();
    // The other parity recovers another key, never the signer.
    expect(authorizationAuthority({ ...BASE_SEPOLIA, yParity: 1 }, 84532)).not.toBe("0x0c397c6c8F94EAA6662eE548fA140e6DfEd4aea6");
  });
});

describe("delegationOf", () => {
  it("reads the 0xef0100 ‖ address designator and nothing else", () => {
    expect(delegationOf("0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b")).toBe(DELEGATE);
    expect(delegationOf("0xEF010063C0C19A282A1B52B07DD5A65B58948A07DAE32B")).toBe(DELEGATE);
    expect(delegationOf("0x")).toBeNull();
    expect(delegationOf("0x6080604052")).toBeNull();
    expect(delegationOf("0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b00")).toBeNull();
    expect(delegationOf("0xef020063c0c19a282a1b52b07dd5a65b58948a07dae32b")).toBeNull();
  });
});
