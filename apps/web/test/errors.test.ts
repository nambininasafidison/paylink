// SPDX-License-Identifier: MIT
/** Every failure in the user's language with its engraved support code; revert data is never trusted as markup. */
import { createTranslator, EN } from "@paylink/i18n";
import { payLinkV2Abi } from "@paylink/sdk";
import { encodeErrorResult, UserRejectedRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { WalletError } from "../src/accounts/types.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError, decodeUiError } from "../src/core/errors.ts";
import { TransactionRevertedError } from "../src/rails/wallet.ts";

const app = { i18n: createTranslator("en", EN, { fallback: EN }) };
const SRC = join(import.meta.dirname, "../src");
const HASH = `0x${"12".repeat(32)}` as const;

describe("decodeUiError", () => {
  it("phrases the app's own errors from their key and parameters, with a stable support code", () => {
    const decoded = decodeUiError(app, new AppError("create.error.precision", { decimals: 6 }, "TooManyDecimals"));
    expect(decoded.message).toContain("6");
    expect(decoded.code).toBe("Error code TooManyDecimals");
    expect(decoded.name).toBe("create.error.precision");
    // A used authorisation reads out as a code a person can say to support, never as the i18n key behind the copy.
    expect(decodeUiError(app, new AppError("pay.error.consumed", {}, "AuthorizationUsed")).code).toBe("Error code AuthorizationUsed");
  });

  it("never shows an i18n key as a support code, whatever the error the app raises", () => {
    const sources = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    /** The argument list of every `new AppError(…)`, parentheses balanced. */
    const calls = (text: string): string[] =>
      [...text.matchAll(/new AppError\(/g)].map((m) => {
        let depth = 1;
        let end = m.index + m[0].length;
        for (; depth > 0 && end < text.length; end += 1) {
          depth += text[end] === "(" ? 1 : text[end] === ")" ? -1 : 0;
        }
        return text.slice(m.index + m[0].length, end - 1);
      });
    const sites = sources.flatMap((file) => calls(readFileSync(join(SRC, file), "utf8")).map((args) => `${file}: ${args}`));
    expect(sites.length).toBeGreaterThan(20);
    for (const site of sites) {
      // The last argument is the code: a quoted PascalCase name.
      expect(site, site).toMatch(/, "[A-Z][A-Za-z]{3,30}"$/);
    }
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
