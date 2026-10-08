// SPDX-License-Identifier: MIT
/**
 * The typed DOM builder (ADR 0006): v1's `h()`, typed. It only ever creates elements, sets attributes through an
 * allowlist and appends text nodes, so markup can never come from data. There is no `innerHTML` anywhere in the app
 * (ESLint bans every HTML sink); event handlers are listeners, never `on*` attributes; styles are custom properties
 * set through the CSSOM (`style.setProperty`), which a `style-src 'self'` policy allows.
 */

export type Child = Node | string | number | bigint | null | undefined | false | readonly Child[];

type Listener<E extends Event> = (event: E) => void;
export type Handlers = { readonly [K in keyof HTMLElementEventMap]?: Listener<HTMLElementEventMap[K]> };

export type AttrValue = string | number | boolean | null | undefined;

export interface Props {
  readonly class?: string | null | readonly (string | false | null | undefined)[];
  /** Attributes (ARIA, data-*, form attributes …). `on*`, `style` and `srcdoc` are refused: use `on` and `vars`. */
  readonly attrs?: Readonly<Record<string, AttrValue>>;
  readonly on?: Handlers;
  /** CSS custom properties only (`--n`), through the CSSOM. */
  readonly vars?: Readonly<Record<`--${string}`, string>>;
  /** Lets the caller keep a reference without a temporary variable. */
  readonly ref?: (element: HTMLElement) => void;
}

const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "xlink:href"]);
const FORBIDDEN_ATTRIBUTE = /^(on|style$|srcdoc$)/i;

/**
 * Only same-origin paths, `https:`, `mailto:` (never used for data) and `data:image/` (EIP-6963 wallet icons are data
 * URIs, spec EIP-6963 §5) are accepted as URLs; `javascript:` and friends throw.
 */
export function safeUrl(value: string): string {
  const trimmed = value.trim();
  // An image data URI may be base64 (`;base64,`) or percent-encoded (`,`), as EIP-6963 icons are; an SVG loaded as an
  // image never runs script.
  if (/^(https:|mailto:)/i.test(trimmed) || /^data:image\/(png|svg\+xml|webp|gif|jpeg)[;,]/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(\/(?!\/)|\.{1,2}\/|#|\?)/.test(trimmed) || /^[A-Za-z0-9_.-]+(\/|$|#|\?)/.test(trimmed)) {
    return trimmed;
  }
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(trimmed)) {
    return trimmed;
  }
  // Same-origin object URLs (file downloads such as the CSV export).
  const origin = typeof location === "undefined" ? null : location.origin;
  if (origin !== null && trimmed.startsWith(`blob:${origin}/`)) {
    return trimmed;
  }
  throw new Error(`refused URL: ${trimmed.slice(0, 40)}`);
}

export function setAttr(element: Element, name: string, value: AttrValue): void {
  if (FORBIDDEN_ATTRIBUTE.test(name)) {
    throw new Error(`refused attribute: ${name}`);
  }
  if (value === null || value === undefined || value === false) {
    element.removeAttribute(name);
    return;
  }
  const text = value === true ? "" : String(value);
  element.setAttribute(name, URL_ATTRIBUTES.has(name.toLowerCase()) && text !== "" ? safeUrl(text) : text);
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    if (Array.isArray(child)) {
      append(parent, ...(child as readonly Child[]));
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child as string | number | bigint)));
    }
  }
}

function classes(value: Props["class"]): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : value.filter((c): c is string => typeof c === "string" && c !== "").join(" ");
}

function apply(element: HTMLElement | SVGElement, props: Props | null | undefined): void {
  if (props === null || props === undefined) {
    return;
  }
  const className = classes(props.class);
  if (className !== "") {
    element.setAttribute("class", className);
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    setAttr(element, name, value);
  }
  for (const [name, value] of Object.entries(props.vars ?? {})) {
    element.style.setProperty(name, value);
  }
  for (const [type, listener] of Object.entries(props.on ?? {}) as [string, EventListener][]) {
    element.addEventListener(type, listener);
  }
}

/** `h("p", { class: "lede" }, "text", h("strong", null, "bold"))`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  apply(element, props);
  append(element, ...children);
  props?.ref?.(element);
  return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** SVG through `createElementNS` (the QR code, the brand mark, icons). */
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, AttrValue>> = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    setAttr(element, name, value);
  }
  append(element, ...children);
  return element;
}

/** Replaces an element's children. */
export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}
