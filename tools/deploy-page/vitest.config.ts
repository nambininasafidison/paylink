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
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["../../web/v2/deploy/lib/**/*.js"],
      reporter: ["text", "json-summary"],
    },
  },
});
