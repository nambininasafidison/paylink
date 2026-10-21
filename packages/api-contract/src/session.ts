// SPDX-License-Identifier: MIT
/**
 * `POST /v1/session` (docs/paypal/SPEC.md §12.2). The payee signs an EIP-712 `PayLinkSession` with the wallet (decision
 * D-SCOPE: EIP-6963 wallets only, no passkeys); the API verifies the signature and returns an HMAC token valid at most
 * 12 hours (E). Only the payee's own twins and desk are reachable with it. Owner: reconciler workstream.
 */
import type { Address, Hex, IsoInstant } from "./common.ts";

/** The EIP-712 domain of a session (E): bound to the PayPal edition's chain, no verifying contract (nothing on chain). */
export const SESSION_DOMAIN = { name: "PayLink API", version: "1" } as const;

/** The EIP-712 type of a session (docs/paypal/SPEC.md §12.2: payee, origin, issuedAt, expiresAt, nonce). */
export const SESSION_TYPES = {
  PayLinkSession: [
    { name: "payee", type: "address" },
    { name: "origin", type: "string" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Longest session the API grants (E). */
export const SESSION_MAX_SECONDS = 12 * 60 * 60;

/** The signed message, with the uint64 fields as decimal strings (unix seconds). */
export interface PayLinkSessionMessage {
  readonly payee: Address;
  /** The page's origin, which must be an allowed origin of the API. */
  readonly origin: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: Hex;
}

export interface SessionRequest {
  readonly chainId: number;
  readonly session: PayLinkSessionMessage;
  /** The payee's EIP-712 signature (65-byte ECDSA, or ERC-1271 bytes for a smart account). */
  readonly signature: Hex;
}

export interface SessionResponse {
  /** Opaque bearer token for `Authorization: Bearer <token>`. */
  readonly token: string;
  readonly payee: Address;
  readonly expiresAt: IsoInstant;
}
