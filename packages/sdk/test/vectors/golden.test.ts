// SPDX-License-Identifier: MIT
/**
 * Golden-vector parity with the Solidity side (PAYLINK-V2-SPEC §3.5): protocol/test/vectors/*.json are written
 * by protocol/test/vectors/GoldenVectors.t.sol, which computes every value twice (the deployed PayLinkV2 and an
 * independent EIP-712 reference) and proves each signature is accepted on-chain. The SDK must reproduce every
 * value byte for byte: domain separators, struct hashes, keys, packed bytes, base64url, fragments, payment
 * nonces, EIP-3009 digests, cancel digests, and the RFC 6979 signatures themselves.
 */
import { readFileSync } from "node:fs";
import { defineLocalChain, nativeToken, createRegistry } from "@paylink/chains";
import type { Erc20Token, Registry, Token } from "@paylink/chains";
import { bytesToHex, getAddress, hexToBytes, keccak256, stringToHex, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  CANCEL_TYPE,
  CANCEL_TYPEHASH,
  cancelDigest,
  cancelStructHash,
  decodeInvoiceFragment,
  domainSeparator,
  EIP712_DOMAIN_TYPE,
  EIP712_DOMAIN_TYPEHASH,
  encodeInvoiceFragment,
  hashMemo,
  INVOICE_TYPE,
  INVOICE_TYPEHASH,
  invoiceKey,
  invoiceStructHash,
  invoiceTypedData,
  isPayLinkError,
  packInvoice,
  PAYMENT_BINDING_TYPE,
  PAYMENT_BINDING_TYPEHASH,
  paymentNonce,
  payLinkDomain,
  RECEIVE_WITH_AUTHORIZATION_TYPE,
  RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
  receiveWithAuthorizationDigest,
  signCancel,
  signInvoice,
  signReceiveAuthorization,
  unpackInvoice,
  verifySignature,
} from "../../src/index.ts";
import type { Invoice } from "../../src/index.ts";

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../../protocol/test/vectors/${name}`, import.meta.url), "utf8"));

interface InvoiceVector {
  readonly payee: string;
  readonly token: string;
  readonly amount: string;
  readonly validAfter: string;
  readonly validUntil: string;
  readonly maxPayments: string;
  readonly salt: string;
  readonly memoHash: string;
}

interface Party {
  readonly label: string;
  readonly privateKey: Hex;
  readonly address: Address;
}

interface Eip712File {
  readonly schema: string;
  readonly domain: { readonly typeString: string; readonly typeHash: Hex; readonly name: string; readonly version: string };
  readonly invoiceType: { readonly typeString: string; readonly typeHash: Hex };
  readonly payee: Party;
  readonly vectors: readonly {
    readonly name: string;
    readonly chainId: string;
    readonly verifyingContract: Address;
    readonly domainSeparator: Hex;
    readonly invoice: InvoiceVector;
    readonly memo: string | null;
    readonly structHash: Hex;
    readonly key: Hex;
    readonly signature: Hex;
    readonly packed: Hex;
    readonly packedBase64url: string;
    readonly signatureBase64url: string;
    readonly wireValid: boolean;
    readonly fragment: string | null;
  }[];
}

interface NonceFile {
  readonly schema: string;
  readonly typeString: string;
  readonly typeHash: Hex;
  readonly payer: Party;
  readonly vectors: readonly {
    readonly key: Hex;
    readonly payer: Address;
    readonly amount: string;
    readonly payerRef: Hex;
    readonly payerSalt: Hex;
    readonly nonce: Hex;
  }[];
  readonly receiveWithAuthorization: {
    readonly tokenName: string;
    readonly tokenVersion: string;
    readonly chainId: string;
    readonly token: Address;
    readonly tokenDomainSeparator: Hex;
    readonly typeString: string;
    readonly typeHash: Hex;
    readonly key: Hex;
    readonly from: Address;
    readonly to: Address;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly payerRef: Hex;
    readonly payerSalt: Hex;
    readonly nonce: Hex;
    readonly digest: Hex;
    readonly v: string;
    readonly r: Hex;
    readonly s: Hex;
  };
}

interface CancelFile {
  readonly schema: string;
  readonly typeString: string;
  readonly typeHash: Hex;
  readonly payee: Party;
  readonly invoice: InvoiceVector;
  readonly vectors: readonly {
    readonly chainId: string;
    readonly verifyingContract: Address;
    readonly key: Hex;
    readonly deadline: string;
    readonly structHash: Hex;
    readonly digest: Hex;
    readonly signature: Hex;
    readonly acceptedAtGenerationTime: boolean;
  }[];
}

const eip712 = load("eip712.json") as Eip712File;
const nonce = load("nonce.json") as NonceFile;
const cancel = load("cancel.json") as CancelFile;

const toInvoice = (v: InvoiceVector): Invoice => ({
  payee: v.payee as Address,
  token: v.token as Address,
  amount: BigInt(v.amount),
  validAfter: BigInt(v.validAfter),
  validUntil: BigInt(v.validUntil),
  maxPayments: Number(v.maxPayments),
  salt: v.salt as Hex,
  memoHash: v.memoHash as Hex,
});

/** A registry with one local chain whose canonical deployment is the vector's `verifyingContract`. */
function registryFor(chainId: number, verifyingContract: Address, tokenAddress: Address): Registry {
  const token: Token =
    tokenAddress === zeroAddress
      ? nativeToken({ symbol: "ETH", name: "Native", decimals: 18, listing: "default", confidence: "C" })
      : ({
          kind: "erc20",
          symbol: "MOCK",
          name: "Vector token",
          address: tokenAddress,
          decimals: 6,
          capabilities: { eip3009: true, eip2612: true, native: false },
          eip712Domain: { name: "USDC", version: "2" },
          listing: "default",
          confidence: "C",
          pendingVerification: [],
        } satisfies Erc20Token);
  return createRegistry([
    defineLocalChain({
      chainId,
      rpcUrl: "http://127.0.0.1:8545",
      tokens: [token],
      deployment: {
        address: verifyingContract,
        status: "active",
        release: "2.0.0",
        method: "CREATE",
        deployer: zeroAddress,
        txHash: `0x${"00".repeat(32)}`,
        blockNumber: 0n,
        initCodeHash: `0x${"00".repeat(32)}`,
        maskedRuntimeHash: `0x${"00".repeat(32)}`,
        runtimeCodeHash: `0x${"00".repeat(32)}`,
      },
    }),
  ]);
}

describe("vector files", () => {
  it("use the schemas and type strings of the SDK", () => {
    expect([eip712.schema, nonce.schema, cancel.schema]).toEqual(["paylink.vectors.eip712/1", "paylink.vectors.nonce/1", "paylink.vectors.cancel/1"]);
    expect([eip712.domain.typeString, eip712.domain.typeHash]).toEqual([EIP712_DOMAIN_TYPE, EIP712_DOMAIN_TYPEHASH]);
    expect([eip712.domain.name, eip712.domain.version]).toEqual(["PayLink", "2"]);
    expect([eip712.invoiceType.typeString, eip712.invoiceType.typeHash]).toEqual([INVOICE_TYPE, INVOICE_TYPEHASH]);
    expect([nonce.typeString, nonce.typeHash]).toEqual([PAYMENT_BINDING_TYPE, PAYMENT_BINDING_TYPEHASH]);
    expect([nonce.receiveWithAuthorization.typeString, nonce.receiveWithAuthorization.typeHash]).toEqual([
      RECEIVE_WITH_AUTHORIZATION_TYPE,
      RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
    ]);
    expect([cancel.typeString, cancel.typeHash]).toEqual([CANCEL_TYPE, CANCEL_TYPEHASH]);
  });

  it("derive every test key and address from its public label", () => {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    for (const party of [eip712.payee, nonce.payer, cancel.payee]) {
      const key = (BigInt(keccak256(stringToHex(party.label))) % (n - 1n)) + 1n;
      expect(party.privateKey).toBe(`0x${key.toString(16).padStart(64, "0")}`);
      expect(privateKeyToAccount(party.privateKey).address).toBe(party.address);
    }
    for (const label of ["paylink.vectors.verifyingContract.A", "paylink.vectors.verifyingContract.B"]) {
      const address = getAddress(`0x${keccak256(stringToHex(label)).slice(26)}`);
      expect(eip712.vectors.some((v) => v.verifyingContract === address)).toBe(true);
    }
  });

  it("cover every registry chain, two deployments, the wire limits and both decimal scales", () => {
    const chains = new Set(eip712.vectors.map((v) => v.chainId));
    for (const id of ["31337", "10143", "143", "84532", "421614", "31611", "5042002"]) {
      expect(chains.has(id)).toBe(true);
    }
    expect(new Set(eip712.vectors.map((v) => v.verifyingContract)).size).toBe(2);
    expect(eip712.vectors.some((v) => !v.wireValid)).toBe(true);
    expect(eip712.vectors.length).toBeGreaterThanOrEqual(19);
    expect(nonce.vectors.length).toBeGreaterThanOrEqual(5);
    expect(cancel.vectors.length).toBeGreaterThanOrEqual(9);
  });
});

describe("eip712.json: invoices", () => {
  const payee = privateKeyToAccount(eip712.payee.privateKey);

  describe.each(eip712.vectors.map((v, i) => [`#${i} ${v.name} (chain ${v.chainId}, ${v.verifyingContract.slice(0, 8)})`, v] as const))("%s", (_label, v) => {
    const chainId = Number(v.chainId);
    const deployment = { chainId, verifyingContract: v.verifyingContract };
    const invoice = toInvoice(v.invoice);

    it("domain separator, struct hash and key", () => {
      expect(domainSeparator(payLinkDomain(deployment))).toBe(v.domainSeparator);
      expect(invoiceStructHash(invoice)).toBe(v.structHash);
      expect(invoiceKey(deployment, invoice)).toBe(v.key);
    });

    it("memo hash", () => {
      expect(hashMemo(v.memo)).toBe(v.invoice.memoHash);
    });

    it("packed invoice and base64url", () => {
      const packed = packInvoice(invoice);
      expect(bytesToHex(packed)).toBe(v.packed);
      expect(base64UrlEncode(packed)).toBe(v.packedBase64url);
      expect(unpackInvoice(hexToBytes(v.packed))).toEqual(invoice);
      expect(base64UrlEncode(hexToBytes(v.signature))).toBe(v.signatureBase64url);
    });

    it("re-signs to the identical RFC 6979 signature, which verifies", async () => {
      expect(await payee.signTypedData(invoiceTypedData(deployment, invoice))).toBe(v.signature);
      const signed = await signInvoice({ signer: payee, deployment, invoice });
      expect(signed.signature).toBe(v.signature);
      expect((await verifySignature({ signer: invoice.payee, digest: v.key, signature: v.signature })).valid).toBe(true);
    });

    if (v.wireValid) {
      it("encodes to the identical fragment and decodes back", () => {
        const fragment = encodeInvoiceFragment({ chainId, invoice, signature: v.signature, memo: v.memo });
        expect(fragment).toBe(v.fragment);
        const decoded = decodeInvoiceFragment(fragment, registryFor(chainId, v.verifyingContract, invoice.token));
        expect(decoded.invoice).toEqual(invoice);
        expect([decoded.signature, decoded.memo, decoded.key, decoded.chainId]).toEqual([v.signature, v.memo, v.key, chainId]);
      });
    } else {
      it("is refused on the wire with E_UINT53_RANGE (contract-only edge case)", () => {
        expect(v.fragment).toBeNull();
        expect(() => encodeInvoiceFragment({ chainId, invoice, signature: v.signature, memo: v.memo })).toThrow(/E_UINT53_RANGE/);
        const forged = ["2", v.chainId, v.packedBase64url, v.signatureBase64url].join(".");
        try {
          decodeInvoiceFragment(forged, registryFor(chainId, v.verifyingContract, invoice.token));
          expect.unreachable();
        } catch (error) {
          expect(isPayLinkError(error, "E_UINT53_RANGE")).toBe(true);
        }
      });
    }
  });
});

describe("nonce.json: payment binding", () => {
  it.each(nonce.vectors.map((v, i) => [i, v] as const))("vector #%i", (_i, v) => {
    expect(paymentNonce({ key: v.key, payer: v.payer, amount: BigInt(v.amount), payerRef: v.payerRef, payerSalt: v.payerSalt })).toBe(v.nonce);
  });

  it("receiveWithAuthorization: token domain, nonce, digest and the identical v, r, s", async () => {
    const r = nonce.receiveWithAuthorization;
    const tokenDomain = { name: r.tokenName, version: r.tokenVersion, chainId: Number(r.chainId), verifyingContract: r.token };
    expect(domainSeparator(tokenDomain)).toBe(r.tokenDomainSeparator);
    const binding = { key: r.key, payer: r.from, amount: BigInt(r.value), payerRef: r.payerRef, payerSalt: r.payerSalt };
    expect(paymentNonce(binding)).toBe(r.nonce);
    const message = { from: r.from, to: r.to, value: BigInt(r.value), validAfter: BigInt(r.validAfter), validBefore: BigInt(r.validBefore), nonce: r.nonce };
    expect(receiveWithAuthorizationDigest(tokenDomain, message)).toBe(r.digest);
    const signed = await signReceiveAuthorization({
      signer: privateKeyToAccount(nonce.payer.privateKey),
      tokenDomain,
      verifyingContract: r.to,
      key: r.key,
      amount: BigInt(r.value),
      validAfter: BigInt(r.validAfter),
      validBefore: BigInt(r.validBefore),
      payerRef: r.payerRef,
      payerSalt: r.payerSalt,
    });
    expect([signed.nonce, signed.digest]).toEqual([r.nonce, r.digest]);
    expect([signed.authorization.v, signed.authorization.r, signed.authorization.s]).toEqual([Number(r.v), r.r, r.s]);
    expect(signed.authorization.payer).toBe(r.from);
  });
});

describe("cancel.json: signed cancellations", () => {
  const payee = privateKeyToAccount(cancel.payee.privateKey);
  const invoice = toInvoice(cancel.invoice);

  it.each(cancel.vectors.map((v, i) => [i, v.chainId, v.deadline.slice(0, 12), v] as const))("vector #%i (chain %s, deadline %s)", async (_i, _c, _d, v) => {
    const deployment = { chainId: Number(v.chainId), verifyingContract: v.verifyingContract };
    const deadline = BigInt(v.deadline);
    expect(invoiceKey(deployment, invoice)).toBe(v.key);
    expect(cancelStructHash(v.key, deadline)).toBe(v.structHash);
    expect(cancelDigest(deployment, v.key, deadline)).toBe(v.digest);
    const signed = await signCancel({ signer: payee, deployment, invoice, deadline });
    expect(signed.signature).toBe(v.signature);
    expect(signed.deadline).toBe(deadline);
  });
});
