// SPDX-License-Identifier: MIT
/**
 * Why a PayLink key (passkey) could not be used, as the pages word it (`error.passkey.*`). Its own module, so the
 * error decoder knows it in every edition without pulling the passkey layer into editions that have none.
 */

/** Why a ceremony failed. */
export type PasskeyFailure =
  /** The browser or the authenticator offers no WebAuthn, or the user cancelled or timed out. */
  | "cancelled"
  /** The authenticator answered without a PRF output: it cannot hold a PayLink key. */
  | "prf-unavailable"
  /** The passkey that answered derives another account than the one this device expects. */
  | "other-key"
  /** Anything else (crypto unavailable, malformed answer). */
  | "failed";

export class PasskeyUseError extends Error {
  readonly failure: PasskeyFailure | "unsupported";

  constructor(failure: PasskeyFailure | "unsupported", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PasskeyUseError";
    this.failure = failure;
  }
}
