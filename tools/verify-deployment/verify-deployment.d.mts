// SPDX-License-Identifier: MIT
// Type surface of verify-deployment.mjs for TypeScript callers (the e2e suite runs the CLI in-process).

/** Where the CLI writes; the command line passes process.stdout/stderr. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** The --help text. */
export declare const USAGE: string;

/** Runs the CLI with `argv` (without node and the script path). Resolves to the exit status: 0, 1 or 2. */
export declare function main(argv: string[], io: Io): Promise<number>;
