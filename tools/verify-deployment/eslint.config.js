// SPDX-License-Identifier: MIT
import { defineConfig } from "eslint/config";
import { paylinkConfig } from "@paylink/eslint-config";

export default defineConfig(paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "node" }), {
  name: "paylink/verify-deployment-cli",
  files: ["verify-deployment.mjs"],
  // A command-line tool writes to its streams through the injected io object; Node globals are typed by tsc.
  rules: { "no-undef": "off" },
});
