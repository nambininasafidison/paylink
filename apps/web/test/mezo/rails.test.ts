// SPDX-License-Identifier: MIT
/**
 * The wallet and batch rails as the Mezo edition builds them: Mezo testnet's RPC answers `null` for mined transactions
 * (docs/research/mezo.md §2, ADR 0017), so a wait that ends without the receipt of a payment already sent is
 * `PaymentUnconfirmedError`, never a failure, and its `resume` reads the same payment again: nothing is sent twice.
 */
import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError } from "viem";
import type { Hex, TransactionReceipt } from "viem";
import { memoryOutstandingAuthorizationStore, payLinkV2Abi } from "@paylink/sdk";
import { describe, expect, it } from "vitest";
import type { AccountProvider, TransactionRequest } from "../../src/accounts/types.ts";
import { relayerClient } from "../../src/core/relayer.ts";
import { batchRail } from "../../src/rails/batch.ts";
import { PaymentUnconfirmedError } from "../../src/rails/types.ts";
import type { PaymentContext } from "../../src/rails/types.ts";
import { walletRail } from "../../src/rails/wallet.ts";
import { CONTRACT, fakeChain, issue, localChain, NOW, payer, registry, TOKEN_ADDRESS } from "../helpers.ts";

const TX = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

function paidReceipt(hash: Hex, key: Hex, payee: Hex, amount: bigint, logIndex: number): TransactionReceipt {
  const log = {
    address: CONTRACT,
    topics: encodeEventTopics({ abi: payLinkV2Abi, eventName: "Paid", args: { key, payee, payer: payer.address } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "bytes32" }], [TOKEN_ADDRESS, amount, 0, `0x${"00".repeat(32)}`]),
    logIndex,
    blockNumber: 101n,
    blockHash: TX(9),
    transactionHash: hash,
    transactionIndex: 0,
    removed: false,
  };
  return { transactionHash: hash, status: "success", blockNumber: 101n, logs: [log] } as unknown as TransactionReceipt;
}

/** A payment context whose RPC returns a receipt only once the test puts it in `receipts`. */
async function context(account: Partial<AccountProvider>, receipts: Map<Hex, TransactionReceipt>) {
  const { link } = await issue();
  const fake = fakeChain();
  fake.allowances.set(`${payer.address.toLowerCase()}:${CONTRACT.toLowerCase()}`, link.invoice.amount);
  const sent: TransactionRequest[] = [];
  const provider: AccountProvider = {
    connector: { id: "dev.paylink.test", name: "Test", icon: null, layer: "eip6963" },
    kind: "injected",
    address: payer.address,
    chainId: () => Promise.resolve(31337),
    switchChain: () => Promise.resolve(),
    signTypedData: (typed) => payer.signTypedData(typed),
    sendTransaction: (request) => {
      sent.push(request);
      return Promise.resolve(TX(5));
    },
    onChange: () => () => undefined,
    ...account,
  };
  const ctx: PaymentContext = {
    link,
    chain: localChain(),
    account: provider,
    client: {
      ...fake.client,
      estimateGas: () => Promise.resolve(120_000n),
      waitForReceipt: (hash: Hex) => {
        const found = receipts.get(hash);
        return found === undefined ? Promise.reject(new TransactionReceiptNotFoundError({ hash })) : Promise.resolve(found);
      },
    },
    amount: link.invoice.amount,
    payerRef: `0x${"00".repeat(32)}`,
    now: NOW,
    onStep: () => undefined,
    registry,
    relayer: relayerClient({ relayer: null }),
    authorizations: memoryOutstandingAuthorizationStore(),
  };
  return { ctx, sent, link };
}

describe("Mezo edition rails: a payment sent whose receipt is not returned yet", () => {
  it("wallet rail: unconfirmed, not failed; resume reads it again and nothing is sent twice", async () => {
    const receipts = new Map<Hex, TransactionReceipt>();
    const { ctx, sent, link } = await context({}, receipts);
    const error = await walletRail().execute("approve-pay", ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentUnconfirmedError);
    const unconfirmed = error as PaymentUnconfirmedError;
    expect(unconfirmed.txHash).toBe(TX(5));
    await expect(unconfirmed.resume()).rejects.toBeInstanceOf(PaymentUnconfirmedError);
    receipts.set(TX(5), paidReceipt(TX(5), link.key, link.invoice.payee, link.invoice.amount, 2));
    expect(await unconfirmed.resume()).toMatchObject({ txHash: TX(5), logIndex: 2 });
    expect(sent).toHaveLength(1);
  });

  it("batch rail: a batch the wallet confirmed is read again, never sent twice", async () => {
    const receipts = new Map<Hex, TransactionReceipt>();
    let batches = 0;
    const { ctx, link } = await context(
      {
        sendCalls: () => {
          batches += 1;
          return Promise.resolve({ status: "confirmed" as const, txHashes: [TX(6)] });
        },
      },
      receipts,
    );
    const error = await batchRail().execute("batched-approve-pay", ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentUnconfirmedError);
    expect((error as PaymentUnconfirmedError).txHash).toBe(TX(6));
    receipts.set(TX(6), paidReceipt(TX(6), link.key, link.invoice.payee, link.invoice.amount, 3));
    expect(await (error as PaymentUnconfirmedError).resume()).toMatchObject({ txHash: TX(6), logIndex: 3 });
    expect(batches).toBe(1);
  });
});
