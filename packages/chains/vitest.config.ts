// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary", "lcov"],
      // PAYLINK-V2-SPEC §4.1: chains 100 %.
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
});
