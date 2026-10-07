// SPDX-License-Identifier: MIT
// @ts-check
/**
 * The page's only DOM builder. It never parses HTML: text goes through `textContent`, attributes through
 * `setAttribute` (event-handler attributes refused), listeners through `addEventListener` (PAYLINK-V2-SPEC §3.6).
 *
 * @module
 */

/**
 * @typedef {string | number | boolean | null | undefined} AttrValue
 * @typedef {Node | string | null | undefined | false} Child
 */

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, AttrValue | ((event: Event) => void)>} [props]  `class`, `text`, data-/aria- attributes,
 *   other attributes, and `on<event>` listeners as functions
 * @param {...(Child | Child[])} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (typeof value === "function") {
      if (!key.startsWith("on")) {
        throw new Error(`h(): ${key} is a function but not an on<event> listener`);
      }
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "text") {
      el.textContent = String(value);
    } else if (/^on/i.test(key) || key === "srcdoc") {
      throw new Error(`h(): refusing attribute ${key}`);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

/**
 * @param {Element} el
 * @param {(Child | Child[])[]} children
 */
function append(el, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

/**
 * Replaces an element's children.
 * @param {Element} el
 * @param {...(Child | Child[])} children
 */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
export function byId(id) {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`#${id} missing`);
  }
  return el;
}

/**
 * An address or hash grouped by four after `0x`, for reading aloud and comparing (spec §3.10). `data-value` and the
 * title hold the full value; the groups are presentation.
 *
 * @param {string} value
 * @param {{ tail?: boolean }} [options]  emphasise the last group (addresses)
 * @returns {HTMLElement}
 */
export function grouped(value, { tail = true } = {}) {
  const body = value.slice(2);
  /** @type {string[]} */
  const groups = [];
  for (let i = 0; i < body.length; i += 4) {
    groups.push(body.slice(i, i + 4));
  }
  const last = groups.length - 1;
  // Screen readers get the groups as one spaced string; the visual groups are hidden from them. Copying selects only
  // the visual groups (the spoken copy is user-select: none), which concatenate to the exact value.
  return h(
    "span",
    { class: "hex", "data-value": value, title: value, translate: "no" },
    h("span", { class: "sr-only hex-spoken", text: `0x ${groups.join(" ")}` }),
    h("span", { class: "hex-0x", "aria-hidden": "true", text: "0x" }),
    ...groups.map((g, i) => h("span", { class: tail && i === last ? "hex-g hex-end" : "hex-g", "aria-hidden": "true", text: g })),
  );
}

/**
 * `0x448e…5082`: for places where the full value is one click away.
 * @param {string} value
 */
export const short = (value) => `${value.slice(0, 6)}…${value.slice(-4)}`;
