// SPDX-License-Identifier: MIT
/**
 * The registry-dependent checks of invoice spec §10.5 (steps 5 and 8 to 12), shared by the URL decoder,
 * the JSON parser and relayer-side validation, so that every entry point applies exactly the same rules in
 * the same order.
 */
import type { Registry, Token, V2Target } from "@paylink/chains";
import { keccak256 } from "viem";
import type { Hex } from "viem";
import { MAX_MEMO_BYTES, MAX_SIGNATURE_LENGTH, MAX_UINT53 } from "./constants.ts";
import { invoiceKey } from "./eip712.ts";
import { PayLinkError } from "./errors.ts";
import type { PayLinkErrorCode } from "./errors.ts";
import { hasMemo, invoiceShapeIssue } from "./invoice.ts";
import type { Invoice } from "./types.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Throws a `PayLinkError`; typed `never` so control flow narrows after it. */
export function fail(code: PayLinkErrorCode, message: string, params: Record<string, string> = {}): never {
  throw new PayLinkError(code, message, params);
}

/** Step 5: a chain ID within uint53 that has a canonical v2 deployment in the registry. */
export function resolveTarget(chainId: number, registry: Registry): V2Target {
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    fail("E_CHAIN_ID_FORMAT", "chain ID must be an integer in [1, 2^53 - 1]");
  }
  const target = registry.v2Target(chainId);
  if (target === undefined) {
    return fail("E_CHAIN_UNKNOWN", `chain ${chainId} has no canonical PayLink v2 deployment in the registry`, { chainId: String(chainId) });
  }
  return target;
}

/** How the memo travels with the invoice. */
export type MemoInput =
  /** With a link or a signed-invoice object: present exactly when `memoHash` is not zero (steps 9 and 10). */
  | { readonly mode: "attached"; readonly bytes: Uint8Array | undefined }
  /** In relayer requests: never sent (§11.2), so no memo rule applies. */
  | { readonly mode: "omitted" };

export interface ValidatedInvoice {
  readonly key: Hex;
  readonly token: Token;
  /** The memo as text when it was attached, otherwise `null`. */
  readonly memo: string | null;
}

/**
 * Steps 8 to 12 of §10.5, in order: signature length, memo presence and content, shape (with the uint53 rule)
 * against the registry's `verifyingContract`, and the token allowlist. Returns the invoice key.
 */
export function validateInvoiceParts(parameters: {
  readonly chainId: number;
  readonly target: V2Target;
  readonly registry: Registry;
  readonly invoice: Invoice;
  readonly signatureLength: number;
  readonly memo: MemoInput;
}): ValidatedInvoice {
  const { chainId, target, registry, invoice, signatureLength, memo } = parameters;
  // 8. Signature length (65 bytes for EOAs is enforced at verification, §6.2).
  if (signatureLength < 1 || signatureLength > MAX_SIGNATURE_LENGTH) {
    fail("E_SIGNATURE_LENGTH", `the signature is ${signatureLength} bytes; expected 1 to ${MAX_SIGNATURE_LENGTH}`);
  }
  let memoText: string | null = null;
  if (memo.mode === "attached") {
    // 9. Memo present exactly when memoHash is not zero.
    if (hasMemo(invoice) !== (memo.bytes !== undefined)) {
      fail("E_MEMO_PRESENCE", "the memo must be present exactly when memoHash is not zero");
    }
    // 10. 1 to 280 bytes of well-formed UTF-8 that hash to memoHash: the exact bytes, never normalised.
    if (memo.bytes !== undefined) {
      if (memo.bytes.length < 1 || memo.bytes.length > MAX_MEMO_BYTES) {
        fail("E_MEMO_LENGTH", `the memo is ${memo.bytes.length} bytes; expected 1 to ${MAX_MEMO_BYTES}`);
      }
      try {
        memoText = utf8.decode(memo.bytes);
      } catch {
        fail("E_MEMO_UTF8", "the memo is not well-formed UTF-8");
      }
      if (keccak256(memo.bytes) !== invoice.memoHash) {
        fail("E_MEMO_HASH", "the memo does not hash to memoHash");
      }
    }
  }
  // 11. Shape, uint53 rule first, against the registry's verifyingContract.
  if (invoice.validAfter > MAX_UINT53 || invoice.validUntil > MAX_UINT53) {
    fail("E_UINT53_RANGE", "validAfter and validUntil must be at most 2^53 - 1");
  }
  const issue = invoiceShapeIssue(invoice, target.deployment.address);
  if (issue !== null) {
    fail("E_INVOICE_SHAPE", `invalid invoice shape: ${issue}`, { issue });
  }
  // 12. Token on the allowlist of the chain (scope the registry to the edition with scopeToEdition).
  const token = registry.findToken(chainId, invoice.token);
  if (token === undefined) {
    return fail("E_TOKEN_UNKNOWN", `token ${invoice.token} is not on the allowlist of chain ${chainId}`, {
      token: invoice.token,
      denied: registry.findDenied(chainId, invoice.token) === undefined ? "false" : "true",
    });
  }
  return { key: invoiceKey({ chainId, verifyingContract: target.deployment.address }, invoice), token, memo: memoText };
}
