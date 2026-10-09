// SPDX-License-Identifier: MIT
import { defineConfig, devices } from "@playwright/test";

/**
 * Submission captures (docs/submissions/README.md), never part of `pnpm test`: the brand artwork (`capture/brand.spec.ts`)
 * and the product screenshots (`capture/screens.spec.ts`, against anvil forks of the testnets, so it needs egress to
 * their RPCs). Output: docs/submissions/assets/. Run with `pnpm --filter @paylink/e2e capture`.
 */
export default defineConfig({
  testDir: "capture",
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
  expect: { timeout: 60_000 },
  forbidOnly: process.env["CI"] !== undefined,
  reporter: [["list"]],
  outputDir: "test-results/capture",
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
