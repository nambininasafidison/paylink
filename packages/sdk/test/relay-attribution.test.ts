// SPDX-License-Identifier: MIT
/**
 * Attribution of post-simulation reverts (invoice spec §13.3; audit finding A-04): every cause from chain evidence,
 * in the documented order, against a scripted chain. The anvil suite replays the main causes on the real contract.
 */
import { createRegistry, defineLocalChain } from "@paylink/chains";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  RawContractError,
  stringToHex,
  toFunctionSelector,
} from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { attributeRelayRevert, AUTHORIZATION_USED_EVENT, isPayLinkError, payLinkV2Abi, replayRevertData, requesterFromIp } from "../src/index.ts";
import type { AttributionClient, LinkState, ReceiptLike, RelayTicket } from "../src/index.ts";
import { CHAIN_ID, CONTRACT, deploymentAt, payee, payer, registry, T0, token3009, TOKEN } from "./helpers.ts";

const KEY: Hex = `0x${"ab".repeat(32)}`;
const NONCE: Hex = `0x${"cd".repeat(32)}`;
const REF: Hex = `0x${"ef".repeat(32)}`;
const TX: Hex = `0x${"12".repeat(32)}`;
const INCLUSION = { blockNumber: 1_000n, timestamp: T0 + 10n };

const payTicket: RelayTicket = {
  id: "1",
  kind: "pay",
  chainId: CHAIN_ID,
  contract: CONTRACT,
  key: KEY,
  payee: payee.address,
  payer: payer.address,
  token: TOKEN,
  requester: requesterFromIp("198.51.100.1"),
  admittedAt: T0,
  validThrough: T0 + 599n,
  payeeCodeHash: null,
  payerCodeHash: null,
  payment: { nonce: NONCE, amount: 25_000_000n, payerRef: REF },
};
const cancelTicket: RelayTicket = { ...payTicket, id: "2", kind: "cancel", payer: null, payerCodeHash: null, payment: null, validThrough: T0 + 3600n };

/** PayLinkV2's `Paid` log, as `payWithAuthorization` emits it right before the token's `AuthorizationUsed`. */
function paidLog(logIndex: number, overrides: { contract?: Address; payerRef?: Hex; amount?: bigint } = {}) {
  return {
    address: overrides.contract ?? CONTRACT,
    topics: encodeEventTopics({ abi: payLinkV2Abi, eventName: "Paid", args: { key: KEY, payee: payee.address, payer: payer.address } }) as Hex[],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint32" }, { type: "bytes32" }], [TOKEN, overrides.amount ?? 25_000_000n, 3, overrides.payerRef ?? REF]),
    logIndex,
  };
}
function authorizationUsedLog(logIndex: number) {
  return { address: TOKEN, topics: encodeEventTopics({ abi: [AUTHORIZATION_USED_EVENT], eventName: "AuthorizationUsed", args: { authorizer: payer.address, nonce: NONCE } }) as Hex[], data: "0x" as Hex, logIndex };
}

interface Chain {
  consumed?: boolean;
  link?: Partial<LinkState>;
  code?: Readonly<Record<string, Hex>>;
  /** AuthorizationUsed(payer, NONCE) logs by block. */
  usedAt?: readonly { block: bigint; transactionHash: Hex | null; logIndex: number | null }[];
  receipts?: Readonly<Record<Hex, ReceiptLike>>;
}

const STATE_OF = toFunctionSelector("stateOf(bytes32)");
const AUTHORIZATION_STATE = toFunctionSelector("authorizationState(address,bytes32)");

/** A scripted chain, read at the inclusion block only. */
function chain(script: Chain): AttributionClient & { readonly logQueries: { fromBlock: bigint; toBlock: bigint }[] } {
  const logQueries: { fromBlock: bigint; toBlock: bigint }[] = [];
  const atInclusion = (blockNumber: bigint): void => {
    expect(blockNumber).toBe(INCLUSION.blockNumber);
  };
  return {
    logQueries,
    getCode: ({ address, blockNumber }) => {
      atInclusion(blockNumber);
      return Promise.resolve(script.code?.[address.toLowerCase()]);
    },
    call: ({ to, data, blockNumber }) => {
      atInclusion(blockNumber);
      if (data.startsWith(AUTHORIZATION_STATE)) {
        expect(to).toBe(TOKEN);
        const { args } = decodeFunctionData({ abi: parseAbi(["function authorizationState(address, bytes32) view returns (bool)"]), data });
        expect(args).toEqual([payer.address, NONCE]);
        return Promise.resolve({ data: encodeAbiParameters([{ type: "bool" }], [script.consumed ?? false]) });
      }
      expect([to, data.slice(0, 10)]).toEqual([CONTRACT, STATE_OF]);
      const state = { payments: 0, cancelled: false, lastPaidAt: 0n, total: 0n, ...script.link };
      return Promise.resolve({ data: encodeFunctionResult({ abi: payLinkV2Abi, functionName: "stateOf", result: state }) });
    },
    getLogs: ({ address, args, fromBlock, toBlock }) => {
      expect([address, args]).toEqual([TOKEN, { authorizer: payer.address, nonce: NONCE }]);
      logQueries.push({ fromBlock, toBlock });
      return Promise.resolve((script.usedAt ?? []).filter((log) => log.block >= fromBlock && log.block <= toBlock));
    },
    getTransactionReceipt: ({ hash }) => {
      const receipt = script.receipts?.[hash];
      return receipt === undefined ? Promise.reject(new Error(`no receipt ${hash}`)) : Promise.resolve(receipt);
    },
  };
}

const attribute = async (script: Chain, options: { ticket?: RelayTicket; revertData?: Hex | null; timestamp?: bigint; simulatedAt?: bigint; registry?: typeof registry } = {}) =>
  await attributeRelayRevert({
    client: chain(script),
    registry: options.registry ?? registry,
    ticket: options.ticket ?? payTicket,
    inclusion: { ...INCLUSION, ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }) },
    simulatedAt: options.simulatedAt ?? INCLUSION.blockNumber - 2n,
    revertData: options.revertData ?? null,
  });

const errorString = (reason: string): Hex => encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], errorName: "Error", args: [reason] });
/** PayLinkV2 custom errors, ABI-encoded. */
const contractErrors = {
  InvalidSignature: encodeErrorResult({ abi: payLinkV2Abi, errorName: "InvalidSignature" }),
  SoldOut: encodeErrorResult({ abi: payLinkV2Abi, errorName: "SoldOut", args: [1] }),
  Expired: encodeErrorResult({ abi: payLinkV2Abi, errorName: "Expired", args: [T0] }),
  Cancelled: encodeErrorResult({ abi: payLinkV2Abi, errorName: "Cancelled" }),
  ReceivedMismatch: encodeErrorResult({ abi: payLinkV2Abi, errorName: "ReceivedMismatch", args: [1n, 0n] }),
} as const;
const contractError = (name: keyof typeof contractErrors): Hex => contractErrors[name];
const settledByUs: Chain = {
  consumed: true,
  usedAt: [{ block: INCLUSION.blockNumber - 1n, transactionHash: TX, logIndex: 5 }],
  receipts: { [TX]: { status: "success", blockNumber: INCLUSION.blockNumber - 1n, logs: [paidLog(4), authorizationUsedLog(5)] } },
};

describe("attributeRelayRevert: superseded (nothing went wrong)", () => {
  it("recognises the same authorization settling this payment in another transaction (spec §8.6 resubmission, copied calldata)", async () => {
    expect(await attribute(settledByUs, { revertData: errorString("FiatTokenV2: authorization is used or canceled") })).toEqual({ cause: "superseded", detail: "authorization-settled-this-payment" });
    // Even when the relay was also late: the payment went through.
    expect((await attribute(settledByUs, { timestamp: T0 + 600n })).cause).toBe("superseded");
  });

  it("recognises a cancellation that already happened", async () => {
    expect(await attribute({ link: { cancelled: true } }, { ticket: cancelTicket, revertData: contractError("Cancelled") })).toEqual({ cause: "superseded", detail: "invoice-already-cancelled" });
  });

  it("does not accept a consumption that is not this payment as superseding: the payer spent its nonce", async () => {
    const elsewhere = (logs: ReceiptLike["logs"], status: ReceiptLike["status"] = "success"): Chain => ({
      consumed: true,
      usedAt: [{ block: INCLUSION.blockNumber, transactionHash: TX, logIndex: 5 }],
      receipts: { [TX]: { status, blockNumber: INCLUSION.blockNumber, logs } },
    });
    const spent = { cause: "payer", detail: "authorization-spent-elsewhere" };
    // transferWithAuthorization with the same nonce: no Paid before it.
    expect(await attribute(elsewhere([authorizationUsedLog(5)]))).toEqual(spent);
    // A Paid of another payment, a look-alike event from another contract, a Paid that is not adjacent.
    expect(await attribute(elsewhere([paidLog(4, { payerRef: `0x${"00".repeat(32)}` }), authorizationUsedLog(5)]))).toEqual(spent);
    expect(await attribute(elsewhere([paidLog(4, { amount: 1n }), authorizationUsedLog(5)]))).toEqual(spent);
    expect(await attribute(elsewhere([paidLog(4, { contract: TOKEN }), authorizationUsedLog(5)]))).toEqual(spent);
    expect(await attribute(elsewhere([paidLog(3), authorizationUsedLog(5)]))).toEqual(spent);
    expect(await attribute(elsewhere([paidLog(4), authorizationUsedLog(5)], "reverted"))).toEqual(spent);
    // The token says the nonce is spent, but no log was found in the window (cancelAuthorization).
    expect(await attribute({ consumed: true })).toEqual(spent);
    expect(await attribute({ consumed: true, usedAt: [{ block: INCLUSION.blockNumber, transactionHash: null, logIndex: null }] })).toEqual(spent);
  });

  it("searches backwards from the inclusion block in chunks of the chain's eth_getLogs cap", async () => {
    const capped = createRegistry([{ ...defineLocalChain({ chainId: CHAIN_ID, rpcUrl: "http://127.0.0.1:8545", tokens: [token3009], deployment: deploymentAt() }), rpcLimits: { maxLogBlockRange: 100 } }]);
    const script: Chain = { ...settledByUs, usedAt: [{ block: 850n, transactionHash: TX, logIndex: 5 }] };
    const client = chain(script);
    const result = await attributeRelayRevert({ client, registry: capped, ticket: payTicket, inclusion: INCLUSION, simulatedAt: 760n, revertData: null });
    expect(result.cause).toBe("superseded");
    expect(client.logQueries).toEqual([
      { fromBlock: 901n, toBlock: 1000n },
      { fromBlock: 801n, toBlock: 900n },
    ]);
    const missing = chain({ consumed: true });
    await attributeRelayRevert({ client: missing, registry: capped, ticket: payTicket, inclusion: INCLUSION, simulatedAt: 760n, revertData: null });
    expect(missing.logQueries.at(-1)).toEqual({ fromBlock: 760n, toBlock: 800n });
    // Without a cap: one query over the whole window.
    const uncapped = chain({ consumed: true });
    await attributeRelayRevert({ client: uncapped, registry, ticket: payTicket, inclusion: INCLUSION, simulatedAt: 760n, revertData: null });
    expect(uncapped.logQueries).toEqual([{ fromBlock: 760n, toBlock: 1000n }]);
  });
});

describe("attributeRelayRevert: late inclusion (the relayer's own latency)", () => {
  it("blames nobody when the block is past validThrough, whatever the revert says", async () => {
    for (const ticket of [payTicket, cancelTicket]) {
      expect(await attribute({ consumed: false }, { ticket, timestamp: ticket.validThrough + 1n, revertData: errorString("FiatTokenV2: authorization is expired") })).toEqual({
        cause: "late-inclusion",
        detail: "time-bound-passed-before-inclusion",
      });
    }
    // A spent nonce does not override it: the relay would have failed anyway.
    expect((await attribute({ consumed: true }, { timestamp: T0 + 600n })).cause).toBe("late-inclusion");
    // At validThrough exactly, the bound still held: not late.
    expect((await attribute({}, { timestamp: T0 + 599n })).cause).toBe("unattributed");
  });
});

describe("attributeRelayRevert: payer and payee evidence", () => {
  it("blames the payer for a code change (EIP-7702 delegation after the check)", async () => {
    expect(await attribute({ code: { [payer.address.toLowerCase()]: `0xef0100${"de".repeat(20)}` } })).toEqual({ cause: "payer", detail: "payer-code-changed" });
    // A payer relayed with code (relayPayersWithCode) whose code is unchanged is not blamed for that.
    const code: Hex = `0xef0100${"de".repeat(20)}`;
    expect((await attribute({ code: { [payer.address.toLowerCase()]: code } }, { ticket: { ...payTicket, payerCodeHash: keccak256(code) } })).cause).toBe("unattributed");
  });

  it("blames the payee for a code change or a cancelled invoice", async () => {
    const delegation: Hex = `0xef0100${"aa".repeat(20)}`;
    expect(await attribute({ code: { [payee.address.toLowerCase()]: delegation } })).toEqual({ cause: "payee", detail: "payee-code-changed" });
    expect(await attribute({ code: { [payee.address.toLowerCase()]: delegation } }, { ticket: cancelTicket })).toEqual({ cause: "payee", detail: "payee-code-changed" });
    expect(await attribute({ link: { cancelled: true } }, { revertData: contractError("Cancelled") })).toEqual({ cause: "payee", detail: "invoice-cancelled" });
    // A wallet payee whose code hash is unchanged: decided by the revert data.
    const wallet: Hex = "0x6080604052";
    expect(await attribute({ code: { [payee.address.toLowerCase()]: wallet } }, { ticket: { ...payTicket, payeeCodeHash: keccak256(wallet) }, revertData: contractError("InvalidSignature") })).toEqual({
      cause: "payee",
      detail: "contract:InvalidSignature",
    });
  });
});

describe("attributeRelayRevert: revert data", () => {
  const tokenAbi = [{ type: "error", name: "ERC20InsufficientBalance", inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] }] as const;

  it.each([
    ["the contract's InvalidSignature", contractError("InvalidSignature"), "payee"],
    ["SoldOut (a race)", contractError("SoldOut"), "sold-out"],
    ["the token's invalid signature (payer's ERC-1271 answer)", errorString("FiatTokenV2: invalid signature"), "payer"],
    ["a FiatToken balance error", errorString("ERC20: transfer amount exceeds balance"), "payer"],
    ["an OpenZeppelin balance error", encodeErrorResult({ abi: tokenAbi, errorName: "ERC20InsufficientBalance", args: [payer.address, 0n, 1n] }), "payer"],
    ["a paused token", errorString("Pausable: paused"), "token"],
    ["a blocked account", errorString("Blacklistable: account is blacklisted"), "token"],
    ["'used' while the token says unused (contradiction)", errorString("FiatTokenV2: authorization is used or canceled"), "unattributed"],
    ["'expired' inside the window (contradiction)", errorString("FiatTokenV2: authorization is expired"), "unattributed"],
    ["Expired inside the window (contradiction)", contractError("Expired"), "unattributed"],
    ["Cancelled while the link is not (contradiction)", contractError("Cancelled"), "unattributed"],
    ["an exactness failure", contractError("ReceivedMismatch"), "unattributed"],
    ["an unknown revert", errorString("something else"), "unattributed"],
    ["an unknown selector", "0xdeadbeef", "unattributed"],
    ["empty revert data (out of gas)", "0x", "unattributed"],
  ] as const)("pay: %s → %s", async (_name, revertData, cause) => {
    expect((await attribute({}, { revertData })).cause).toBe(cause);
  });

  it("reports no evidence as unattributed, with details for the logs", async () => {
    expect(await attribute({})).toEqual({ cause: "unattributed", detail: "no-revert-data" });
    expect(await attribute({}, { revertData: contractError("SoldOut") })).toEqual({ cause: "sold-out", detail: "contract:SoldOut" });
    expect(await attribute({}, { revertData: errorString("Pausable: paused") })).toEqual({ cause: "token", detail: "token:Pausable: paused" });
  });

  it.each([
    ["InvalidSignature", contractError("InvalidSignature"), "payee"],
    ["SoldOut", contractError("SoldOut"), "unattributed"],
    ["a token error", errorString("Pausable: paused"), "unattributed"],
  ] as const)("cancel: %s → %s", async (_name, revertData, cause) => {
    expect((await attribute({}, { ticket: cancelTicket, revertData })).cause).toBe(cause);
  });

  it("refuses a simulation block after the inclusion block", async () => {
    let caught: unknown;
    try {
      await attribute({}, { simulatedAt: INCLUSION.blockNumber + 1n });
    } catch (error) {
      caught = error;
    }
    expect(isPayLinkError(caught) ? caught.params["rule"] : caught).toBe("RelayEvidence");
  });
});

describe("replayRevertData", () => {
  const call = { to: CONTRACT, data: "0x12345678" as Hex, value: 0n };

  it("returns the revert data of a replay that reverts, and null otherwise", async () => {
    const data = errorString("FiatTokenV2: authorization is expired");
    const seen: unknown[] = [];
    const reverting = {
      call: (parameters: unknown) => {
        seen.push(parameters);
        return Promise.reject(new RawContractError({ data }));
      },
    };
    expect(await replayRevertData({ client: reverting, from: payer.address, call, gas: 224_000n, blockNumber: 7n })).toBe(data);
    expect(seen).toEqual([{ account: payer.address, to: CONTRACT, data: "0x12345678", value: 0n, gas: 224_000n, blockNumber: 7n }]);
    expect(await replayRevertData({ client: { call: () => Promise.resolve({ data: "0x" }) }, from: payer.address, call, gas: 1n, blockNumber: 7n })).toBeNull();
    expect(await replayRevertData({ client: { call: () => Promise.reject(new Error(stringToHex("not viem"))) }, from: payer.address, call, gas: 1n, blockNumber: 7n })).toBeNull();
  });
});
