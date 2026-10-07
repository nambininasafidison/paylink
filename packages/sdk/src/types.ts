// SPDX-License-Identifier: MIT
/**
 * Protocol data types. Integer widths follow the contract (IPayLinkV2): fields that can exceed 2^53 are
 * `bigint`, `uint32` fields are `number`, exactly as viem encodes them, so these objects go straight into
 * contract calls and typed-data signing.
 */
import type { Address, Hex } from "viem";

/** The EIP-712 `Invoice` (invoice spec §3.1). */
export interface Invoice {
  /** Receives the funds and signs: an EOA or a deployed ERC-1271 account. */
  readonly payee: Address;
  /** ERC-20 token, or the zero address for the native coin. */
  readonly token: Address;
  /** Base units; 0 = open amount (the payer chooses, > 0). uint128. */
  readonly amount: bigint;
  /** Unix seconds, inclusive. uint64 on-chain; conforming clients stay within uint53. */
  readonly validAfter: bigint;
  /** Unix seconds, inclusive; 0 = no expiry. */
  readonly validUntil: bigint;
  /** 1 = one-off, N = N payments, 0 = unlimited. uint32. */
  readonly maxPayments: number;
  /** 32 CSPRNG bytes, lowercase hex. */
  readonly salt: Hex;
  /** keccak256 of the UTF-8 memo, or 32 zero bytes. */
  readonly memoHash: Hex;
}

/** An invoice with the payee's signature over its key, for one chain (invoice spec §2.4). */
export interface SignedInvoice {
  readonly chainId: number;
  readonly invoice: Invoice;
  /** 65-byte ECDSA (EOA payee) or 1–512 opaque bytes (ERC-1271 payee), lowercase hex. */
  readonly signature: Hex;
  /** The memo text, present exactly when `invoice.memoHash` is not zero. Untrusted when received. */
  readonly memo: string | null;
}

/** On-chain state of one key (`stateOf`), invoice spec §7.1. */
export interface LinkState {
  readonly payments: number;
  readonly cancelled: boolean;
  readonly lastPaidAt: bigint;
  readonly total: bigint;
}

/** The state of a key that was never paid or cancelled. */
export const EMPTY_LINK_STATE: LinkState = Object.freeze({ payments: 0, cancelled: false, lastPaidAt: 0n, total: 0n });

/** The tuple an EIP-3009 authorization is bound to (invoice spec §8.2). */
export interface PaymentBinding {
  readonly key: Hex;
  readonly payer: Address;
  readonly amount: bigint;
  readonly payerRef: Hex;
  readonly payerSalt: Hex;
}

/** `IPayLinkV2.Authorization`: the payer's EIP-3009 signature fields. The token nonce is never carried. */
export interface Authorization {
  readonly payer: Address;
  readonly amount: bigint;
  readonly payerRef: Hex;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly payerSalt: Hex;
  readonly v: number;
  readonly r: Hex;
  readonly s: Hex;
}

/** `IPayLinkV2.Permit`: an EIP-2612 permit for spender = PayLinkV2, owner = the payer. */
export interface Permit {
  readonly deadline: bigint;
  readonly v: number;
  readonly r: Hex;
  readonly s: Hex;
}

/** A payee-signed `Cancel(bytes32 key,uint256 deadline)` for `cancelBySig` (invoice spec §9.2). */
export interface CancelAuthorization {
  readonly chainId: number;
  readonly invoice: Invoice;
  readonly deadline: bigint;
  readonly signature: Hex;
}

/** Identifies one `Paid` event (invoice spec §10.6, §12). */
export interface ReceiptReference {
  readonly chainId: number;
  /** Lowercase `0x` + 64 hex digits. */
  readonly txHash: Hex;
  /** Block-level log index of the `Paid` event. */
  readonly logIndex: number;
}

/**
 * Something that signs EIP-712 typed data as `address`: a viem `LocalAccount` as is, or a wallet client
 * wrapped as `{ address, signTypedData: (t) => walletClient.signTypedData({ account, ...t }) }`.
 */
export interface TypedDataSigner {
  readonly address: Address;
  signTypedData(typedData: {
    readonly domain: {
      readonly name: string;
      readonly version: string;
      readonly chainId: number;
      readonly verifyingContract: Address;
    };
    readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
    readonly primaryType: string;
    readonly message: Record<string, unknown>;
  }): Promise<Hex>;
}
