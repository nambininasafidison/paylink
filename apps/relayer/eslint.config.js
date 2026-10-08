// SPDX-License-Identifier: MIT
import { paylinkConfig } from "@paylink/eslint-config";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  // deploy/worker.js is generated (scripts/build.ts) and checked by build:check, not linted.
  globalIgnores(["deploy/**"]),
  // src/core is isomorphic (Worker and Node); src/worker runs on workerd; src/node on Node.
  paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "isomorphic" }),
  {
    name: "relayer/node-adapter",
    files: ["src/node/**/*.ts"],
    rules: { "no-restricted-globals": "off", "no-restricted-imports": "off" },
  },
  {
    name: "relayer/node-cli",
    files: ["src/node/main.ts"],
    rules: { "no-console": "off" },
  },
);
