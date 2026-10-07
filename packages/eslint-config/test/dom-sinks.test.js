// SPDX-License-Identifier: MIT
// The DOM-sink ban (spec §3.6, §4.1) against every form it must catch, and the lookalikes it must leave alone.
// Regression for the audit finding that `Object.assign(el, { innerHTML })`, `el.setHTMLUnsafe(html)`,
// `el.srcdoc = html` and `el["innerHTML"] = html` passed lint. Run: node --test (pnpm --filter
// @paylink/eslint-config test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";
import { domSinkSyntax, paylinkConfig } from "../index.js";

const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [{ languageOptions: { ecmaVersion: "latest", sourceType: "module" }, rules: { "no-restricted-syntax": ["error", ...domSinkSyntax] } }],
});

async function reported(code) {
  const [result] = await eslint.lintText(code, { filePath: "fixture.js" });
  return result.messages.map((m) => m.ruleId);
}

const SINKS = {
  "innerHTML assignment": 'el.innerHTML = html;',
  "outerHTML assignment": 'el.outerHTML = html;',
  "srcdoc assignment": 'frame.srcdoc = html;',
  "compound assignment": 'el.innerHTML += html;',
  "computed innerHTML": 'el["innerHTML"] = html;',
  "computed srcdoc": "frame['srcdoc'] = html;",
  "Object.assign with innerHTML": 'Object.assign(el, { innerHTML: html });',
  "Object.assign with a string key": 'Object.assign(el, { "outerHTML": html });',
  "spread prop bag": 'const props = { ...base, innerHTML: html }; Object.assign(el, props);',
  "shorthand property": 'const innerHTML = html; Object.assign(el, { innerHTML });',
  "Reflect.set": 'Reflect.set(el, "innerHTML", html);',
  "Object.defineProperty": 'Object.defineProperty(el, "srcdoc", { value: html });',
  "setAttribute srcdoc": 'frame.setAttribute("srcdoc", html);',
  "setAttribute event handler": 'el.setAttribute("onclick", code);',
  insertAdjacentHTML: 'el.insertAdjacentHTML("beforeend", html);',
  "computed insertAdjacentHTML": 'el["insertAdjacentHTML"]("beforeend", html);',
  createContextualFragment: "range.createContextualFragment(html);",
  setHTMLUnsafe: "el.setHTMLUnsafe(html);",
  "computed setHTMLUnsafe": 'el["setHTMLUnsafe"](html);',
  parseHTMLUnsafe: "Document.parseHTMLUnsafe(html);",
  "DOMParser.parseFromString": 'new DOMParser().parseFromString(html, "text/html");',
  "document.write": "document.write(html);",
  "document.writeln": "document.writeln(html);",
};

for (const [name, code] of Object.entries(SINKS)) {
  test(`reports ${name}`, async () => {
    assert.deepEqual(await reported(code), ["no-restricted-syntax"], code);
  });
}

test("leaves safe lookalikes alone", async () => {
  const safe = [
    "el.textContent = text;",
    "const text = el.innerHTML;", // reading is not a sink
    "el.setAttribute('aria-label', label);",
    "el.setAttribute('data-onboarding', step);",
    "const map = { inner: 1, html: 2 };",
    "el.insertAdjacentText('beforeend', text);",
    "const parsed = JSON.parse(text);",
  ];
  for (const code of safe) {
    assert.deepEqual(await reported(code), [], code);
  }
});

test("paylinkConfig bans every selector as an error", () => {
  const configs = paylinkConfig({ tsconfigRootDir: import.meta.dirname });
  const typescript = configs.find((c) => c.name === "paylink/typescript");
  assert.ok(typescript, "the paylink/typescript block exists");
  const [level, ...selectors] = typescript.rules["no-restricted-syntax"];
  assert.equal(level, "error");
  assert.deepEqual(selectors, domSinkSyntax);
});
