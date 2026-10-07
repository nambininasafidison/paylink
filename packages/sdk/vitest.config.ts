// SPDX-License-Identifier: MIT
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (the "@paylink/source" export condition), so tests
  // never depend on a stale dist/ build.
  resolve: { conditions: ["@paylink/source", ...defaultServerConditions] },
  ssr: { resolve: { conditions: ["@paylink/source", ...defaultServerConditions] } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
      reporter: ["text", "json-summary", "lcov"],
      // PAYLINK-V2-SPEC §4.1: SDK >= 90 %.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
