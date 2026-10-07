// SPDX-License-Identifier: MIT
import { defineConfig } from "eslint/config";
import { paylinkConfig } from "@paylink/eslint-config";

export default defineConfig(paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "node" }), {
  name: "paylink/e2e",
  files: ["specs/**/*.ts", "fixtures/**/*.ts"],
  rules: { "no-console": "off", "@typescript-eslint/explicit-module-boundary-types": "off" },
});
