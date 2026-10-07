// SPDX-License-Identifier: MIT
/**
 * Protocol constants of PayLink v2, as literal values from the invoice spec (docs/spec/paylink-invoice-v2.md
 * §4, §5, §8, §9, §10 and §17). `test/constants.test.ts` recomputes every hash from its type string.
 */
import type { Hex } from "viem";

/** Wire-format version token and EIP-712 domain version (spec §16). */
export const WIRE_VERSION = 2;
export const DOMAIN_NAME = "PayLink";
export const DOMAIN_VERSION = "2";

export const EIP712_DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
export const INVOICE_TYPE =
  "Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)";
export const CANCEL_TYPE = "Cancel(bytes32 key,uint256 deadline)";
export const PAYMENT_BINDING_TYPE = "PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)";
export const PERMIT_TYPE = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";
export const RECEIVE_WITH_AUTHORIZATION_TYPE =
  "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
/** EIP-3009 `cancelAuthorization`, signed by the payer under the token's domain (§8.6). */
export const CANCEL_AUTHORIZATION_TYPE = "CancelAuthorization(address authorizer,bytes32 nonce)";

/** §4.1 */
export const EIP712_DOMAIN_TYPEHASH: Hex = "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";
/** §5.1, exposed by the contract as `INVOICE_TYPEHASH()`. */
export const INVOICE_TYPEHASH: Hex = "0x8b0d4e92e431b40f1455755e745c6d48d699d52b9a141b56f0a079793050708e";
/** §9.2, exposed as `CANCEL_TYPEHASH()`. */
export const CANCEL_TYPEHASH: Hex = "0x9e17c698745faeba552ac9e0fa17b141be25ab98edd4766f24b1054263080465";
/** §8.2, exposed as `PAYMENT_BINDING_TYPEHASH()`. */
export const PAYMENT_BINDING_TYPEHASH: Hex = "0x1522042427c11deedb016d62cb8d2ed977e5ba802ccb926d4a8fa50abd9af353";
/** §8.3, EIP-3009. */
export const RECEIVE_WITH_AUTHORIZATION_TYPEHASH: Hex = "0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8";
/** §8.6, EIP-3009 (Circle FiatToken `CANCEL_AUTHORIZATION_TYPEHASH`). */
export const CANCEL_AUTHORIZATION_TYPEHASH: Hex = "0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429";

/** EIP-2612. */
export const PERMIT_TYPEHASH: Hex = "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9";

/** `keccak256("Paid(bytes32,address,address,address,uint128,uint32,bytes32)")`, §12. */
export const PAID_TOPIC: Hex = "0xca30d10d6510d85eb6fa9e2f49f80fc8e789aac9619c3000f100dfa51fd7b31d";
/** `keccak256("InvoiceCancelled(bytes32,address)")`, §17.1. */
export const INVOICE_CANCELLED_TOPIC: Hex = "0x881d07924d83735d00c06370239f77e65622c5033b00ccd03a9358be68de819d";

/** 32 zero bytes: `memoHash` of an invoice without memo, and the default `payerRef`. */
export const ZERO_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** `keccak256("")`. Issuers must never use it as `memoHash` (§3.1): an empty memo is `ZERO_HASH`. */
export const EMPTY_STRING_HASH: Hex = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

/** ERC-1271 magic value, `isValidSignature(bytes32,bytes)` selector (§6.3). */
export const ERC1271_MAGIC_VALUE: Hex = "0x1626ba7e";
/** Code prefix of an EIP-7702 delegated account (§6.4). */
export const EIP7702_DELEGATION_PREFIX: Hex = "0xef0100";

export const MAX_UINT32 = 2n ** 32n - 1n;
/** Largest integer every JavaScript number represents exactly; the wire limit for times and chain IDs (§2.3). */
export const MAX_UINT53 = 2n ** 53n - 1n;
export const MAX_UINT64 = 2n ** 64n - 1n;
export const MAX_UINT128 = 2n ** 128n - 1n;
export const MAX_UINT256 = 2n ** 256n - 1n;
/** secp256k1 n / 2: ECDSA `s` above it is rejected (§6.2, OpenZeppelin ECDSA). */
export const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** §10.4 */
export const PACKED_INVOICE_LENGTH = 140;
/** §6.2: `r ‖ s ‖ v`. */
export const ECDSA_SIGNATURE_LENGTH = 65;
/** §10.2: longest signature a URL carries. */
export const MAX_SIGNATURE_LENGTH = 512;
/** §3.3: memo limit in UTF-8 bytes. */
export const MAX_MEMO_BYTES = 280;
/** §10.3: fragment limit in characters, without the leading `#`. */
export const MAX_FRAGMENT_LENGTH = 1200;
/** §7.1: largest `statesOf` batch. */
export const STATES_OF_MAX_BATCH = 256;

/** Issuers' default validity of a one-off invoice: 7 days (§3.2, §13.1). */
export const DEFAULT_INVOICE_TTL_SECONDS = 7n * 24n * 60n * 60n;
/** Recommended `cancelBySig` deadline: 1 hour (§9.2). */
export const DEFAULT_CANCEL_TTL_SECONDS = 60n * 60n;
/** Recommended EIP-3009 `validBefore` window: 600 s (§8.3). */
export const DEFAULT_AUTHORIZATION_TTL_SECONDS = 600n;
