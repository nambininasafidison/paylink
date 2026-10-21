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
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/node/main.ts", "src/worker/**"],
      reporter: ["text", "json-summary", "lcov"],
    },
  },
});
