// SPDX-License-Identifier: MIT
import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources (the "@paylink/source" export condition) in both test
  // environments: happy-dom for the browser code, node for the build scripts (`// @vitest-environment node`).
  resolve: { conditions: ["@paylink/source", ...defaultClientConditions] },
  ssr: { resolve: { conditions: ["@paylink/source", ...defaultServerConditions] } },
  define: {
    __PAYLINK_EDITION__: JSON.stringify("all"),
    __PAYLINK_E2E_CHAINS__: "null",
    __PAYLINK_RP_ID__: "null",
    __PAYLINK_BUILD__: JSON.stringify({ version: "test", commit: "0000000000000000000000000000000000000000" }),
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "happy-dom",
    restoreMocks: true,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/site.ts"],
      // Entries are one-line boots. Pages render here in every language (test/pages.test.ts); their flows run end to
      // end in e2e/specs/app.spec.ts against anvil, which unit coverage does not count.
      exclude: ["src/entries/**"],
      reporter: ["text", "json-summary"],
      // The logic every page relies on (accounts, the ledger backup, read model, device store, rails, formatting, UI
      // pieces, site assembly) is held to a floor; pages are measured by the e2e suite instead.
      thresholds: {
        "src/{accounts,books,core,read,rails,store,ui}/**": { lines: 85, statements: 85, functions: 85, branches: 75 },
        "scripts/site.ts": { lines: 90, statements: 90, functions: 90, branches: 80 },
      },
    },
  },
});
