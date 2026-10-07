// SPDX-License-Identifier: MIT
//
// Shared ESLint flat config for the PayLink v2 TypeScript packages and apps.
//
// Policy (PAYLINK-V2-SPEC §3.6 and §4.1, CONTRIBUTING.md §5–§6):
//   - typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` on every TypeScript file;
//   - `no-floating-promises` and `no-misused-promises` as errors;
//   - DOM injection sinks banned everywhere (innerHTML, outerHTML and srcdoc in any syntactic form,
//     insertAdjacentHTML, setHTMLUnsafe, parseHTMLUnsafe, DOMParser, document.write, eval,
//     new Function), because passkey-derived keys live in page memory;
//   - isomorphic packages (`environment: "isomorphic"`) must not reach for browser-only or
//     Node-only globals and modules in `src/`, so the same code runs in the web app, the
//     Cloudflare Worker relayer and Node.
//
// Usage (packages/<name>/eslint.config.js):
//   import { paylinkConfig } from "@paylink/eslint-config";
//   export default paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "isomorphic" });

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const SINK = "DOM injection sink: build nodes with h() and textContent (spec §3.6).";
/** Properties whose assignment parses HTML or a document. */
const HTML_PROPERTY = "/^(innerHTML|outerHTML|srcdoc)$/";
/** Methods that parse HTML from a string. */
const HTML_METHOD = "/^(insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe|parseFromString)$/";

/**
 * Selectors and messages for the DOM-sink ban (spec §3.6 "Client security", §4.1 gate). Syntax-only, so they also
 * apply to plain JavaScript. Covered forms, each pinned by test/dom-sinks.test.js:
 *   - assignment to `innerHTML`, `outerHTML` or `srcdoc`, with dot or computed (`el["innerHTML"]`) access;
 *   - the same properties as object-literal keys (`Object.assign(el, { innerHTML })`, spreads, prop bags), and
 *     through `Reflect.set` or `Object.defineProperty`;
 *   - `setAttribute("srcdoc" | "on…", …)`;
 *   - HTML-parsing methods: `insertAdjacentHTML`, `createContextualFragment`, `setHTMLUnsafe`, `parseHTMLUnsafe`
 *     (also `Document.parseHTMLUnsafe`), `DOMParser#parseFromString`, with dot or computed access;
 *   - `document.write` and `document.writeln`.
 * A lint rule cannot follow aliases (`const k = "innerHTML"; el[k] = …`); Trusted Types (`require-trusted-types-for
 * 'script'` in the production CSP) is the runtime backstop for everything the syntax cannot see.
 */
export const domSinkSyntax = [
  { selector: `AssignmentExpression > MemberExpression.left[computed=false][property.name=${HTML_PROPERTY}]`, message: SINK },
  { selector: `AssignmentExpression > MemberExpression.left[computed=true][property.value=${HTML_PROPERTY}]`, message: SINK },
  { selector: `ObjectExpression > Property[computed=false][key.name=${HTML_PROPERTY}]`, message: SINK },
  { selector: `ObjectExpression > Property[key.value=${HTML_PROPERTY}]`, message: SINK },
  {
    selector: `CallExpression[callee.object.name=/^(Reflect|Object)$/][callee.property.name=/^(set|defineProperty)$/][arguments.1.value=${HTML_PROPERTY}]`,
    message: SINK,
  },
  { selector: "CallExpression[callee.property.name='setAttribute'][arguments.0.value=/^(srcdoc|on.*)$/i]", message: SINK },
  { selector: `CallExpression[callee.computed=false][callee.property.name=${HTML_METHOD}]`, message: SINK },
  { selector: `CallExpression[callee.computed=true][callee.property.value=${HTML_METHOD}]`, message: SINK },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: "document.write is banned (spec §3.6).",
  },
];

const browserOnlyGlobals = ["window", "document", "localStorage", "sessionStorage", "indexedDB", "location", "navigator"].map(
  (name) => ({ name, message: `${name} is browser-only; this package must run in the browser, the Worker and Node alike.` }),
);
const nodeOnlyGlobals = ["process", "Buffer", "require", "module", "__dirname", "__filename", "global"].map((name) => ({
  name,
  message: `${name} is Node-only; this package must run in the browser, the Worker and Node alike.`,
}));

/**
 * @param {object} options
 * @param {string} options.tsconfigRootDir Directory of the package's tsconfig.json (pass `import.meta.dirname`).
 * @param {"isomorphic" | "browser" | "node"} [options.environment] Where `src/` runs. Default "isomorphic".
 * @returns {import("eslint").Linter.Config[]}
 */
export function paylinkConfig({ tsconfigRootDir, environment = "isomorphic" }) {
  const isomorphic = environment === "isomorphic";
  return defineConfig(
    globalIgnores(["**/dist/**", "**/coverage/**", "**/node_modules/**"]),
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      name: "paylink/typescript",
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      linterOptions: { reportUnusedDisableDirectives: "error" },
      rules: {
        // Promise discipline (spec §4.1).
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/no-misused-promises": "error",
        "@typescript-eslint/return-await": ["error", "always"],
        // Public API stability and exhaustiveness.
        "@typescript-eslint/explicit-module-boundary-types": "error",
        "@typescript-eslint/switch-exhaustiveness-check": [
          "error",
          { considerDefaultExhaustiveForUnions: true, requireDefaultForNonUnion: true },
        ],
        "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "separate-type-imports" }],
        "@typescript-eslint/consistent-type-exports": "error",
        "@typescript-eslint/no-import-type-side-effects": "error",
        "@typescript-eslint/prefer-readonly": "error",
        "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
        "@typescript-eslint/no-unnecessary-condition": ["error", { allowConstantLoopConditions: "only-allowed-literals" }],
        // Language hygiene.
        eqeqeq: ["error", "always"],
        curly: ["error", "all"],
        "no-console": "error",
        "no-param-reassign": "error",
        "no-var": "error",
        "prefer-const": "error",
        "object-shorthand": "error",
        "no-throw-literal": "off",
        "@typescript-eslint/only-throw-error": "error",
        // DOM and code-injection sinks (spec §3.6).
        "no-eval": "error",
        "no-new-func": "error",
        "no-script-url": "error",
        "no-restricted-syntax": ["error", ...domSinkSyntax],
        "no-restricted-globals": ["error", ...(isomorphic ? [...browserOnlyGlobals, ...nodeOnlyGlobals] : [])],
        "no-restricted-imports": [
          "error",
          {
            patterns: isomorphic
              ? [{ group: ["node:*"], message: "src/ is isomorphic: no Node built-ins (they do not exist in the browser or the Worker)." }]
              : [],
          },
        ],
      },
    },
    {
      name: "paylink/tests-and-scripts",
      files: ["test/**/*.ts", "scripts/**/*.ts", "*.config.ts"],
      rules: {
        // Tests and build scripts run in Node only.
        "no-restricted-globals": "off",
        "no-restricted-imports": "off",
        "no-console": "off",
        "@typescript-eslint/explicit-module-boundary-types": "off",
      },
    },
    {
      name: "paylink/javascript",
      files: ["**/*.js", "**/*.mjs"],
      extends: [tseslint.configs.disableTypeChecked],
      // JavaScript (configs, tooling) carries JSDoc types at most, which this rule cannot see.
      rules: { "no-restricted-globals": "off", "no-restricted-imports": "off", "@typescript-eslint/explicit-module-boundary-types": "off" },
    },
  );
}
