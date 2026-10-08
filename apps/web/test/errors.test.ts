// SPDX-License-Identifier: MIT
/** Every failure in the user's language with its engraved support code; revert data is never trusted as markup. */
import { createTranslator, EN } from "@paylink/i18n";
import { payLinkV2Abi } from "@paylink/sdk";
import { encodeErrorResult, UserRejectedRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { WalletError } from "../src/accounts/types.ts";
import { AppError, decodeUiError } from "../src/core/errors.ts";
import { TransactionRevertedError } from "../src/rails/wallet.ts";

const app = { i18n: createTranslator("en", EN, { fallback: EN }) };
const HASH = `0x${"12".repeat(32)}` as const;

describe("decodeUiError", () => {
  it("phrases the app's own errors from their key and parameters", () => {
    const decoded = decodeUiError(app, new AppError("create.error.precision", { decimals: 6 }));
    expect(decoded.message).toContain("6");
    expect(decoded.code).toBe("Error code create.error.precision");
    expect(decoded.name).toBe("create.error.precision");
  });

  it("names wallet refusals, wrong networks and pending prompts", () => {
    expect(decodeUiError(app, new WalletError(4001, "User rejected the request.")).name).toBe("UserRejectedRequestError");
    expect(decodeUiError(app, new UserRejectedRequestError(new Error("no"))).name).toBe("UserRejectedRequestError");
    expect(decodeUiError(app, new WalletError(4902, "Unrecognized chain"))).toMatchObject({ name: "WrongNetwork", code: "Error code EIP1193 4902" });
    expect(decodeUiError(app, new WalletError(-32002, "Already processing"))).toMatchObject({ name: "RequestPending" });
    expect(decodeUiError(app, new WalletError(-32603, "Internal"))).toMatchObject({ name: "WalletError", code: "Error code EIP1193 -32603" });
  });

  it("decodes a mined revert from its replayed data", () => {
    const soldOut = decodeUiError(app, new TransactionRevertedError(HASH, encodeErrorResult({ abi: payLinkV2Abi, errorName: "SoldOut", args: [3] })));
    expect(soldOut.name).toBe("SoldOut");
    expect(soldOut.code).toBe("Error code SoldOut");
    expect(soldOut.message).toContain("3");
    expect(decodeUiError(app, new TransactionRevertedError(HASH, null)).name).toBe("Reverted");
  });

  it("falls back to a generic sentence, never to the raw error text", () => {
    const decoded = decodeUiError(app, new Error("<img src=x onerror=alert(1)>"));
    expect(decoded.message).not.toContain("<img");
    expect(decoded.message.length).toBeGreaterThan(0);
  });
});
