// SPDX-License-Identifier: MIT
// The shared config is imported by path, not as a workspace devDependency: Envio Cloud may install this package on its
// own from its Root Directory, where a "workspace:*" specifier cannot resolve (docs/runbooks/envio.md). Lint only runs
// inside the workspace, where the path exists.
import { defineConfig, globalIgnores } from "eslint/config";
import { paylinkConfig } from "../../packages/eslint-config/index.js";

export default defineConfig(
  // Envio codegen output.
  globalIgnores([".envio/**", "envio-env.d.ts", "generated/**"]),
  // Handlers run on Node (Envio's runtime); src/ never touches the network or the file system.
  paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "node" }),
);
