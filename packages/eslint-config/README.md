# @paylink/eslint-config

Shared ESLint flat config for the PayLink v2 TypeScript workspace (`packages/*`, `apps/*`).

| Rule set | Why |
|---|---|
| typescript-eslint `strictTypeChecked` and `stylisticTypeChecked`, with the project service | PAYLINK-V2-SPEC §4.1 gate |
| `no-floating-promises`, `no-misused-promises`, `return-await` | Promise discipline (spec §4.1) |
| `explicit-module-boundary-types`, `switch-exhaustiveness-check`, `consistent-type-imports` | Stable public API; exhaustive handling of protocol error codes |
| Bans on `innerHTML`, `outerHTML` and `srcdoc` in every syntactic form (dot or computed assignment, object-literal keys as in `Object.assign(el, { innerHTML })`, `Reflect.set`, `Object.defineProperty`), `setAttribute("srcdoc")` and `on…` handlers, `insertAdjacentHTML`, `createContextualFragment`, `setHTMLUnsafe`, `parseHTMLUnsafe`, `DOMParser#parseFromString`, `document.write`, `eval`, `new Function` | DOM-injection sinks (spec §3.6): passkey-derived keys live in page memory. `test/dom-sinks.test.js` pins every form and the safe lookalikes (`pnpm --filter @paylink/eslint-config test`). Aliased keys (`el[k] = …`) are out of reach of syntax; Trusted Types in the production CSP is the runtime backstop |
| `environment: "isomorphic"`: no browser-only or Node-only globals, no `node:*` imports in `src/` | The SDK and the registry run unchanged in the web app, the Cloudflare Worker relayer and Node |

```js
// packages/<name>/eslint.config.js
import { paylinkConfig } from "@paylink/eslint-config";

export default paylinkConfig({ tsconfigRootDir: import.meta.dirname, environment: "isomorphic" });
```

`test/**`, `scripts/**` and `*.config.ts` run in Node, so the isomorphic restrictions and `no-console` are off there. Plain `.js` files are linted without type information.
