// SPDX-License-Identifier: MIT
// The shared config lints itself (plain JavaScript, so without type information).
import { paylinkConfig } from "./index.js";

export default paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "node" });
