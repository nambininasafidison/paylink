// SPDX-License-Identifier: MIT
import { defineConfig, devices } from "@playwright/test";

/**
 * PAYLINK-V2-SPEC §4.2: Playwright 1.56.1 on the preinstalled Chromium 141. In the sandbox the browsers come from
 * PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers and nothing is downloaded (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
 * One worker: the specs start their own anvil chains, and the record-parity spec runs forge in protocol/.
 */
export default defineConfig({
  testDir: "specs",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  forbidOnly: process.env["CI"] !== undefined,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
