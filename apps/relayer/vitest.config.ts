// SPDX-License-Identifier: MIT
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources (the "@paylink/source" export condition).
  resolve: { conditions: ["@paylink/source", ...defaultServerConditions] },
  ssr: { resolve: { conditions: ["@paylink/source", ...defaultServerConditions] } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The anvil and workerd suites start their own chains and processes: one file at a time.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts", "src/node/**/*.ts"],
      exclude: ["src/node/main.ts"],
      reporter: ["text", "json-summary", "lcov"],
      // PAYLINK-V2-SPEC §4.1: relayer >= 85 %. src/worker runs in workerd (test/integration/worker.test.ts), outside v8 coverage.
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
      // The engine is covered by the anvil and workerd suites: run coverage where anvil and protocol/out exist (CI contracts job, sandbox).
    },
  },
});
