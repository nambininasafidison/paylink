// SPDX-License-Identifier: MIT
// Lints the deploy page's JavaScript (web/v2/deploy) with the workspace rules: DOM-sink bans, no eval, eqeqeq, curly,
// no console. Run from the repository root (see the `lint` script): `eslint --config tools/deploy-page/eslint.web.config.js
// web/v2/deploy`. Undefined names are left to `tsc --checkJs` (tsconfig.web.json), which knows the DOM.
import { defineConfig, globalIgnores } from "eslint/config";
import { paylinkConfig } from "@paylink/eslint-config";

export default defineConfig(
  paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "browser" }),
  globalIgnores(["web/v2/deploy/vendor/**"]),
  {
    name: "paylink/deploy-page",
    files: ["web/v2/deploy/**/*.js"],
    languageOptions: { sourceType: "module", ecmaVersion: 2023 },
    rules: { "no-undef": "off" },
  },
);
