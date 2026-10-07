// SPDX-License-Identifier: MIT
/**
 * The worked examples of the invoice spec (docs/spec/paylink-invoice-v2.md §11.3 and §17), which three other
 * implementations agree on (ethers 6.17.0, Foundry cast 1.8.5 and the compiled PayLinkV2 through
 * protocol/test/vectors/SpecExamples.t.sol). The addresses are anvil's public test fixtures, never deployments.
 */
import { readFileSync } from "node:fs";
import { createRegistry, defineLocalChain } from "@paylink/chains";
import { bytesToHex, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  buildInvoice,
  cancelDigest,
  decodeInvoiceFragment,
  domainSeparator,
  encodeInvoiceFragment,
  invoiceKey,
  invoiceStructHash,
  packInvoice,
  parseSignedInvoiceJson,
  paymentNonce,
  payLinkDomain,
  signCancel,
  signInvoice,
  toSignedInvoiceJson,
  verifySignature,
  ZERO_HASH,
} from "../src/index.ts";

// anvil's default accounts 1 and 2 (mnemonic "test test test test test test test test test test test junk").
// Public test keys: never send real funds to them.
const PAYEE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const VERIFYING_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TOKEN = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const deployment = { chainId: 10143, verifyingContract: VERIFYING_CONTRACT } as const;

const { invoice, memo } = buildInvoice({
  payee: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  token: TOKEN,
  amount: 25_000_000n,
  validAfter: 1_791_158_400n,
  expiry: { kind: "at", validUntil: 1_791_763_200n },
  maxPayments: 1,
  salt: keccak256(stringToHex("PayLink invoice v2 example salt")),
  memo: "Logo design, invoice #12",
});

const SIGNATURE =
  "0x9b15ca287effb6724dbbdc508dc3f8418c1c51e38c7df32be3da03a1487de3615537f23f136bfa824748e8a730f38c4ad407223d8f6fd1e9b9ac4309cd6dd1b41b";
const FRAGMENT =
  "2.10143.cJl5cMUYEtw6AQx9AbUODRfcecjn8XJedzTOKI-DZ-G7FD6Quz8FEgAAAAAAAAAAAAAAAAF9eEAAAAAAasLogAAAAABqzCMAAAAAAfWzS_bwk6nn8idQWPzMS0xRfOKzVFXI9pCNnP8HwUjVnkFx70GPLJgFB7-iD3Jis3MB1__V1u8nY0yi2F1rcEE.mxXKKH7_tnJNu9xQjcP4QYwcUeOMffMr49oDoUh942FVN_I_E2v6gkdI6Kcw84xK1AciPY9v0em5rEMJzW3RtBs.TG9nbyBkZXNpZ24sIGludm9pY2UgIzEy";

const registry = createRegistry([
  defineLocalChain({
    chainId: 10143,
    rpcUrl: "http://127.0.0.1:8545",
    tokens: [
      {
        kind: "erc20",
        symbol: "MOCK",
        name: "6-decimal mock",
        address: TOKEN,
        decimals: 6,
        capabilities: { eip3009: true, eip2612: true, native: false },
        eip712Domain: null,
        listing: "default",
        confidence: "C",
        pendingVerification: [],
      },
    ],
    deployment: {
      address: VERIFYING_CONTRACT,
      status: "active",
      release: "2.0.0",
      method: "CREATE",
      deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      txHash: `0x${"00".repeat(32)}`,
      blockNumber: 1n,
      initCodeHash: `0x${"00".repeat(32)}`,
      maskedRuntimeHash: `0x${"00".repeat(32)}`,
      runtimeCodeHash: `0x${"00".repeat(32)}`,
    },
  }),
]);

describe("§17.3 example invoice", () => {
  it("has the stated salt and memo hash", () => {
    expect(invoice.salt).toBe("0xf5b34bf6f093a9e7f2275058fccc4b4c517ce2b35455c8f6908d9cff07c148d5");
    expect(invoice.memoHash).toBe("0x9e4171ef418f2c980507bfa20f7262b37301d7ffd5d6ef27634ca2d85d6b7041");
  });

  it("has the stated domain separator, struct hash and key", () => {
    expect(domainSeparator(payLinkDomain(deployment))).toBe("0x084875ae6ab8d0ac0c9e0e1d2537f8985030baab1d0bfac09d4e0bdac024c27c");
    expect(invoiceStructHash(invoice)).toBe("0x43d51889ef0cc89661659d7d1db9a8fc5e52fabf7dbff2ad3a8307d6ad69a110");
    expect(invoiceKey(deployment, invoice)).toBe("0x7c3bfd66020e278626ebe781b4d26210c763273be3b3c2be4f90bb1631df15df");
  });

  it("has the stated payee signature (RFC 6979, v = 27, low s)", async () => {
    const { signature } = await signInvoice({ signer: privateKeyToAccount(PAYEE_KEY), deployment, invoice });
    expect(signature).toBe(SIGNATURE);
  });

  it("has the stated packed bytes and the 316-character fragment, which decodes back", () => {
    expect(bytesToHex(packInvoice(invoice))).toBe(
      "0x70997970c51812dc3a010c7d01b50e0d17dc79c8e7f1725e7734ce288f8367e1bb143e90bb3f0512000000000000000000000000017d7840000000006ac2e880000000006acc230000000001f5b34bf6f093a9e7f2275058fccc4b4c517ce2b35455c8f6908d9cff07c148d59e4171ef418f2c980507bfa20f7262b37301d7ffd5d6ef27634ca2d85d6b7041",
    );
    const fragment = encodeInvoiceFragment({ chainId: 10143, invoice, signature: SIGNATURE, memo });
    expect(fragment).toBe(FRAGMENT);
    expect(fragment).toHaveLength(316);
    const decoded = decodeInvoiceFragment(FRAGMENT, registry);
    expect(decoded.invoice).toEqual(invoice);
    expect(decoded.memo).toBe("Logo design, invoice #12");
    expect(decoded.key).toBe("0x7c3bfd66020e278626ebe781b4d26210c763273be3b3c2be4f90bb1631df15df");
  });
});

describe("§17.4 cross-chain key", () => {
  it("differs on 84532 and the §17.3 signature does not verify for it", async () => {
    const other = invoiceKey({ chainId: 84532, verifyingContract: VERIFYING_CONTRACT }, invoice);
    expect(other).toBe("0x51051ac00b30aaee2966aa10faa3d1258492509709a21b179aff066c2bcbed2f");
    const check = await verifySignature({ signer: invoice.payee, digest: other, signature: SIGNATURE });
    expect([check.valid, check.failure]).toEqual([false, "wrong-signer"]);
  });
});

describe("§17.5 payment binding", () => {
  it("has the stated nonce", () => {
    expect(
      paymentNonce({
        key: "0x7c3bfd66020e278626ebe781b4d26210c763273be3b3c2be4f90bb1631df15df",
        payer: PAYER,
        amount: 25_000_000n,
        payerRef: ZERO_HASH,
        payerSalt: keccak256(stringToHex("PayLink payment example payer salt")),
      }),
    ).toBe("0xfb35fc12f5759b9a2eda33480fb501423cc85685589966e4d1f378eef8888089");
  });
});

describe("§17.6 signed cancellation", () => {
  it("has the stated digest and signature", async () => {
    const key = invoiceKey(deployment, invoice);
    expect(cancelDigest(deployment, key, 1_791_244_800n)).toBe("0xbee48c48fa887318cf8227108e5578be937b736a207dc284a8224f58974696fa");
    const signed = await signCancel({ signer: privateKeyToAccount(PAYEE_KEY), deployment, invoice, deadline: 1_791_244_800n });
    expect(signed.signature).toBe(
      "0x7aa4bdfaba049e3148492fb392beba80d7c4b9bbb10a9869fe4c182b53263ec43d641475ef1ed97431720670eb92c823c985d09cf941ca38a928954697cdfd141c",
    );
  });
});

describe("§11.3 JSON example (docs/spec/paylink-invoice-v2.schema.json)", () => {
  const schema = JSON.parse(readFileSync(new URL("../../../docs/spec/paylink-invoice-v2.schema.json", import.meta.url), "utf8")) as {
    examples: unknown[];
  };
  const example = schema.examples[0];

  it("parses with the registry checks and serialises back byte for byte", () => {
    const parsed = parseSignedInvoiceJson(example, registry);
    expect(parsed.invoice).toEqual(invoice);
    expect(parsed.signature).toBe(SIGNATURE);
    expect(JSON.stringify(toSignedInvoiceJson(parsed, parsed.key))).toBe(JSON.stringify(example));
  });
});
