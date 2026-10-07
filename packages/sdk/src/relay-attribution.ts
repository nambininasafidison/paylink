// SPDX-License-Identifier: MIT
/**
 * Who made a relayed call revert after its simulation passed (invoice spec §13.3; audit finding A-04).
 *
 * The relayer bans by cause, not by ticket: a revert caused by the payer must never cost an honest payee its
 * relays, and a payment that went through by another route (the payer's own resubmission under spec §8.6, or a copy
 * of the relayer's calldata) must cost nobody anything. `attributeRelayRevert` reads the evidence at the inclusion
 * block and returns the cause that `RelayAdmissionLedger.release` turns into penalties:
 *
 * 1. `superseded` — the token's `authorizationState(payer, nonce)` is spent and the authorization was consumed by
 *    PayLinkV2 for this very payment: an `AuthorizationUsed(payer, nonce)` log immediately preceded, in the same
 *    transaction, by the canonical deployment's `Paid(key, payee, payer, token, amount, ·, payerRef)` (PayLinkV2
 *    emits `Paid` and then calls `receiveWithAuthorization`, whose first log is `AuthorizationUsed`; the nonce
 *    binds `payerSalt`, so no other payment can produce that pair). For a cancellation: the key is cancelled.
 * 2. `late-inclusion` — the block's timestamp is past `validThrough`: the margin held at admission, so inclusion
 *    took longer than the margin. That is the relayer's own latency; alert on it and raise the chain's margin.
 * 3. `payer` — the nonce is spent otherwise (the payer cancelled it on the token or signed another transfer with
 *    it), or the payer's code changed (an EIP-7702 delegation set after the check).
 * 4. `payee` — the payee's code changed, or the invoice is cancelled (only the payee can cancel).
 * 5. The revert data, decoded: PayLinkV2 `InvalidSignature` (payee), `SoldOut` (a race: `sold-out`), the token's
 *    "invalid signature" or insufficient balance (payer), a paused token or a blocked account (`token`, an issuer
 *    action). Anything else, inconsistent evidence, or no revert data: `unattributed`.
 *
 * Evidence comes only from PayLinkV2, the allowlisted token and account code. A party cannot forge evidence against
 * another: only the payer can spend its nonce, move its balance or change its code; only the payee can cancel or
 * change its code. Third parties can only cause `superseded` and `sold-out`, which ban no payer or payee.
 *
 * State is read at the inclusion block, that is after the whole block. A party that changes something and changes it
 * back around the relay within one block leaves no trace: that ends `unattributed`, which bans no party without code.
 * A trace of the mined transaction (`debug_traceTransaction`) gives its exact revert data where the RPC offers one;
 * otherwise `replayRevertData` replays the call at the inclusion block.
 */
import type { Registry } from "@paylink/chains";
import { keccak256 } from "viem";
import type { Address, Hex } from "viem";
import { readAuthorizationState } from "./attempts.ts";
import type { CallRequest } from "./calls.ts";
import { readLinkState } from "./contract.ts";
import { decodeRevertData, revertDataOf } from "./error-decoder.ts";
import { PayLinkError } from "./errors.ts";
import type { ReceiptLike } from "./receipt.ts";
import { decodePaidLog } from "./receipt.ts";
import type { RelayTicket, RevertAttribution, RevertCause } from "./relay-admission.ts";
import type { CallReader } from "./signature.ts";

/** EIP-3009 `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`. */
export const AUTHORIZATION_USED_EVENT = {
  type: "event",
  name: "AuthorizationUsed",
  inputs: [
    { name: "authorizer", type: "address", indexed: true },
    { name: "nonce", type: "bytes32", indexed: true },
  ],
} as const;

/** What attribution reads from the chain. viem's `PublicClient` satisfies it. */
export interface AttributionClient {
  getCode(parameters: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  call(parameters: { to: Address; data: Hex; blockNumber: bigint }): Promise<{ data?: Hex | undefined }>;
  getLogs(parameters: {
    address: Address;
    event: typeof AUTHORIZATION_USED_EVENT;
    args: { authorizer: Address; nonce: Hex };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly { readonly transactionHash: Hex | null; readonly logIndex: number | null }[]>;
  getTransactionReceipt(parameters: { hash: Hex }): Promise<ReceiptLike>;
}

/** Replays a call. viem's `PublicClient` satisfies it. */
export interface ReplayClient {
  call(parameters: { account: Address; to: Address; data: Hex; value: bigint; gas: bigint; blockNumber: bigint }): Promise<unknown>;
}

/**
 * The revert data of a mined relay, by replaying its call with the same sender and gas limit at the inclusion block
 * (`eth_call` sees the state after that block). `null` when the replay succeeds or yields no revert data: then
 * nothing reliable is known, and attribution ends `unattributed` unless other evidence decides.
 */
export async function replayRevertData(parameters: {
  readonly client: ReplayClient;
  readonly from: Address;
  readonly call: CallRequest;
  readonly gas: bigint;
  readonly blockNumber: bigint;
}): Promise<Hex | null> {
  const { client, from, call, gas, blockNumber } = parameters;
  try {
    await client.call({ account: from, to: call.to, data: call.data, value: call.value, gas, blockNumber });
    return null;
  } catch (error) {
    return revertDataOf(error);
  }
}

const attribution = (cause: RevertCause, detail: string): RevertAttribution => ({ cause, detail });
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const codeHash = (code: Hex | undefined): Hex | null => (code === undefined || code === "0x" ? null : keccak256(code));

/** True when the authorization was consumed by PayLinkV2 for exactly this ticket's payment, in [fromBlock, toBlock]. */
async function settledByThisAuthorization(client: AttributionClient, ticket: RelayTicket, payer: Address, payment: NonNullable<RelayTicket["payment"]>, range: { from: bigint; to: bigint; step: bigint }): Promise<boolean> {
  // The nonce is used at most once, so at most one log matches; search from the inclusion block backwards.
  for (let end = range.to; end >= range.from; end -= range.step) {
    const start = end - range.step + 1n > range.from ? end - range.step + 1n : range.from;
    const logs = await client.getLogs({ address: ticket.token, event: AUTHORIZATION_USED_EVENT, args: { authorizer: payer, nonce: payment.nonce }, fromBlock: start, toBlock: end });
    for (const { transactionHash, logIndex } of logs) {
      if (transactionHash === null || logIndex === null) {
        continue;
      }
      const receipt = await client.getTransactionReceipt({ hash: transactionHash });
      const previous = receipt.logs.find((entry) => entry.logIndex === logIndex - 1);
      const paid = receipt.status === "success" && previous !== undefined && same(previous.address, ticket.contract) ? decodePaidLog(previous) : null;
      if (
        paid !== null &&
        paid.key === ticket.key.toLowerCase() &&
        same(paid.payee, ticket.payee) &&
        same(paid.payer, payer) &&
        same(paid.token, ticket.token) &&
        paid.amount === payment.amount &&
        same(paid.payerRef, payment.payerRef)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** The cause told by the revert data alone (step 5). */
function causeFromRevertData(ticket: RelayTicket, revertData: Hex | null): RevertAttribution {
  if (revertData === null) {
    return attribution("unattributed", "no-revert-data");
  }
  const decoded = decodeRevertData(revertData);
  const detail = `${decoded.source}:${decoded.source === "token" && decoded.name === "Error" ? (decoded.params["reason"] ?? "") : decoded.name}`;
  if (decoded.source === "contract") {
    if (decoded.name === "InvalidSignature") {
      return attribution("payee", detail);
    }
    if (decoded.name === "SoldOut" && ticket.kind === "pay") {
      return attribution("sold-out", detail);
    }
    // Cancelled, Expired, NotYetValid, SignatureExpired contradict the state and time read above; the rest
    // (shape, path, amount, exactness) cannot change between simulation and inclusion.
    return attribution("unattributed", detail);
  }
  if (decoded.source === "token" && ticket.kind === "pay") {
    switch (decoded.i18nKey) {
      case "error.token.authorizationInvalid":
      case "error.token.insufficientBalance":
        return attribution("payer", detail);
      case "error.token.paused":
      case "error.token.accountBlocked":
        return attribution("token", detail);
      default:
        // Used, expired or not yet valid contradict the state and time read above.
        return attribution("unattributed", detail);
    }
  }
  return attribution("unattributed", detail);
}

/**
 * Attributes a relay that was included with status 0 although its pre-broadcast simulation passed. Read-only. Hand
 * the result to `RelayAdmissionLedger.release`. Throws on transport errors: keep the ticket in flight and retry.
 */
export async function attributeRelayRevert(parameters: {
  readonly client: AttributionClient;
  /** For the chain's `eth_getLogs` block-range cap (`rpcLimits.maxLogBlockRange`). */
  readonly registry: Registry;
  readonly ticket: RelayTicket;
  /** The block that included the reverted relay, and its timestamp. */
  readonly inclusion: { readonly blockNumber: bigint; readonly timestamp: bigint };
  /** The block the last passing simulation ran against: the same authorization cannot have landed before it. */
  readonly simulatedAt: bigint;
  /** The mined call's revert data, from a trace or `replayRevertData`; `null` when none could be obtained. */
  readonly revertData: Hex | null;
}): Promise<RevertAttribution> {
  const { client, ticket, inclusion, simulatedAt } = parameters;
  if (simulatedAt > inclusion.blockNumber) {
    throw new PayLinkError("E_INVALID_ARGUMENT", "the simulation block must not be after the inclusion block", { rule: "RelayEvidence" });
  }
  const blockNumber = inclusion.blockNumber;
  const atInclusion: CallReader = { call: async ({ to, data }) => await client.call({ to, data, blockNumber }) };
  const cap = parameters.registry.get(ticket.chainId)?.rpcLimits.maxLogBlockRange;
  const step = cap === undefined ? blockNumber - simulatedAt + 1n : BigInt(cap);

  // 1. Superseded: what the relay was for already happened.
  let consumed = false;
  if (ticket.kind === "pay" && ticket.payer !== null && ticket.payment !== null) {
    consumed = await readAuthorizationState({ client: atInclusion, token: ticket.token, payer: ticket.payer, nonce: ticket.payment.nonce });
    if (consumed && (await settledByThisAuthorization(client, ticket, ticket.payer, ticket.payment, { from: simulatedAt, to: blockNumber, step }))) {
      return attribution("superseded", "authorization-settled-this-payment");
    }
  }
  const link = await readLinkState(atInclusion, ticket.contract, ticket.key);
  if (ticket.kind === "cancel" && link.cancelled) {
    return attribution("superseded", "invoice-already-cancelled");
  }
  // 2. The margin held at admission; only inclusion latency can carry a block past `validThrough`.
  if (inclusion.timestamp > ticket.validThrough) {
    return attribution("late-inclusion", "time-bound-passed-before-inclusion");
  }
  // 3. Payer evidence.
  if (consumed) {
    return attribution("payer", "authorization-spent-elsewhere");
  }
  if (ticket.payer !== null && codeHash(await client.getCode({ address: ticket.payer, blockNumber })) !== ticket.payerCodeHash) {
    return attribution("payer", "payer-code-changed");
  }
  // 4. Payee evidence.
  if (codeHash(await client.getCode({ address: ticket.payee, blockNumber })) !== ticket.payeeCodeHash) {
    return attribution("payee", "payee-code-changed");
  }
  if (link.cancelled) {
    return attribution("payee", "invoice-cancelled");
  }
  // 5. The revert data.
  return causeFromRevertData(ticket, parameters.revertData);
}
