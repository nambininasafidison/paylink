// SPDX-License-Identifier: MIT
import { defineConfig, devices } from "@playwright/test";

/** Demo video recordings (docs/submissions/video-scripts.md), never part of `pnpm test`. */
export default defineConfig({
  testDir: "video",
  fullyParallel: false,
  workers: 1,
  timeout: 900_000,
  expect: { timeout: 60_000 },
  reporter: [["list"]],
  outputDir: "test-results/video",
  use: { ...devices["Desktop Chrome"], trace: "off", screenshot: "off" },
});
