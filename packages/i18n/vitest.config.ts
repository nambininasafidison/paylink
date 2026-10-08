// SPDX-License-Identifier: MIT
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@paylink/source", ...defaultServerConditions] },
  ssr: { resolve: { conditions: ["@paylink/source", ...defaultServerConditions] } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
});
