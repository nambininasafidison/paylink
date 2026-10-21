// SPDX-License-Identifier: MIT
import { paylinkConfig } from "@paylink/eslint-config";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  // deploy/worker.js is generated (scripts/build.ts) and checked by build:check; test/vendor holds third-party text.
  globalIgnores(["deploy/**", "test/vendor/**"]),
  // src/ is isomorphic (Worker and Node) except the two entries: src/worker runs on workerd, src/node on Node.
  paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "isomorphic" }),
  {
    name: "api/node-entry",
    files: ["src/node/**/*.ts"],
    rules: { "no-restricted-globals": "off", "no-restricted-imports": "off" },
  },
  {
    name: "api/node-cli",
    files: ["src/node/main.ts"],
    rules: { "no-console": "off" },
  },
);
