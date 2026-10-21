// SPDX-License-Identifier: MIT
import { paylinkConfig } from "@paylink/eslint-config";

export default paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "isomorphic" });
