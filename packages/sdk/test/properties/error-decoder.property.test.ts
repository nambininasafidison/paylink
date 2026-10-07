// SPDX-License-Identifier: MIT
/** Property tests (fast-check, spec §4.1): the error decoder maps every PayLinkV2 error and never throws. */
import fc from "fast-check";
import { bytesToHex, encodeErrorResult } from "viem";
import type { Abi } from "viem";

type AbiError = Extract<Abi[number], { type: "error" }>;
import { describe, expect, it } from "vitest";
import { decodeError, decodeRevertData, payLinkV2Abi, SDK_I18N_KEYS } from "../../src/index.ts";

const errors = (payLinkV2Abi as readonly { type: string }[]).filter((item): item is AbiError => item.type === "error");
const keys = new Set<string>(SDK_I18N_KEYS);

function arbitraryFor(type: string): fc.Arbitrary<unknown> {
  if (type === "address") {
    return fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => bytesToHex(b));
  }
  if (type === "string") {
    return fc.string({ maxLength: 40 });
  }
  const bits = Number(/^uint(\d+)$/.exec(type)?.[1] ?? "256");
  return bits <= 32 ? fc.integer({ min: 0, max: 2 ** bits - 1 }) : fc.bigInt({ min: 0n, max: 2n ** BigInt(bits) - 1n });
}

describe("error decoder properties", () => {
  it.each(errors.map((e) => [e.name, e] as const))("decodes %s with any arguments to its key and named parameters", (_name, error) => {
    fc.assert(
      fc.property(fc.tuple(...error.inputs.map((input) => arbitraryFor(input.type))), (args) => {
        const data = encodeErrorResult({ abi: [error], errorName: error.name, args });
        const decoded = decodeRevertData(data);
        expect(decoded.name).toBe(error.name);
        expect(decoded.source).toBe("contract");
        expect(keys.has(decoded.i18nKey)).toBe(true);
        if (decoded.i18nKey !== "error.contract.unexpected") {
          expect(Object.keys(decoded.params)).toEqual(error.inputs.map((input) => input.name));
          error.inputs.forEach((input, i) => {
            expect(decoded.params[input.name ?? ""]?.toLowerCase()).toBe(String(args[i]).toLowerCase());
          });
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never throws on arbitrary revert data and always returns a known key", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const decoded = decodeRevertData(bytesToHex(bytes));
        expect(keys.has(decoded.i18nKey)).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  it("never throws on arbitrary values", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(keys.has(decodeError(value).i18nKey)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
