// SPDX-License-Identifier: MIT
import { defineConfig, globalIgnores } from "eslint/config";
import { paylinkConfig } from "@paylink/eslint-config";

export default defineConfig(paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "browser" }), globalIgnores(["dist/**", "dist-e2e/**", "dev-dist/**"]));
