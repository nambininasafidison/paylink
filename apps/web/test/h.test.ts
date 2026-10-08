// SPDX-License-Identifier: MIT
/** The DOM builder is the app's only way to make markup (ADR 0006): it must never turn data into markup or script. */
import { describe, expect, it } from "vitest";
import { append, h, replace, safeUrl, setAttr, svg } from "../src/ui/h.ts";
import { rich } from "../src/ui/rich.ts";
import { SCRIPT_URL } from "./helpers.ts";

describe("h()", () => {
  it("creates elements whose text is text, never markup", () => {
    const element = h("p", { class: ["lede", false, null, "x"] }, "<img src=x onerror=alert(1)>", 42, 7n, null, false, undefined, ["a", ["b"]]);
    expect(element.tagName).toBe("P");
    expect(element.className).toBe("lede x");
    expect(element.children).toHaveLength(0);
    expect(element.textContent).toBe("<img src=x onerror=alert(1)>427ab");
  });

  it("sets attributes, listeners and custom properties, and hands back a reference", () => {
    let clicked = 0;
    let ref: HTMLElement | null = null;
    const button = h("button", { attrs: { type: "button", disabled: false, "aria-pressed": "true", hidden: true, title: null }, on: { click: () => (clicked += 1) }, vars: { "--n": "6" }, ref: (e) => (ref = e) });
    button.click();
    expect(clicked).toBe(1);
    expect(ref).toBe(button);
    expect(button.getAttribute("type")).toBe("button");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("hidden")).toBe("");
    expect(button.hasAttribute("title")).toBe(false);
    expect(button.style.getPropertyValue("--n")).toBe("6");
  });

  it("refuses event-handler attributes, style and srcdoc", () => {
    for (const name of ["onclick", "ONERROR", "onload", "style", "srcdoc"]) {
      expect(() => h("div", { attrs: { [name]: "alert(1)" } }), name).toThrow(/refused attribute/);
    }
  });

  it("builds SVG in the SVG namespace", () => {
    const icon = svg("svg", { viewBox: "0 0 2 2" }, svg("path", { d: "M0 0h1v1z" }));
    expect(icon.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(icon.firstElementChild?.getAttribute("d")).toBe("M0 0h1v1z");
  });

  it("replaces and appends children", () => {
    const list = h("ul", null, h("li", null, "old"));
    replace(list, h("li", null, "a"), h("li", null, "b"));
    append(list, "tail");
    expect(list.textContent).toBe("abtail");
  });
});

describe("safeUrl()", () => {
  it.each([
    "https://wa.me/?text=hi",
    "mailto:someone@example.org",
    "/pay/#2.1.abc",
    "./r/",
    "../ledger/",
    "#details",
    "?chain=monad",
    "pay/",
    "http://127.0.0.1:8545/",
    "http://localhost:5173/pay/",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/svg+xml;utf8,<svg/>",
    "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
  ])("accepts %s", (url) => {
    expect(safeUrl(url)).toBe(url);
  });

  it.each([
    SCRIPT_URL,
    ` ${SCRIPT_URL.toUpperCase()}`,
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox",
    "http://evil.example/",
    "//evil.example/x",
    "blob:https://evil.example/123",
    "data:application/xhtml+xml,<x/>",
  ])("refuses %s", (url) => {
    expect(() => safeUrl(url)).toThrow(/refused URL/);
  });

  it("accepts same-origin object URLs only", () => {
    expect(safeUrl(`blob:${location.origin}/1234`)).toBe(`blob:${location.origin}/1234`);
  });

  it("guards URL attributes on every element", () => {
    const a = h("a");
    setAttr(a, "href", "/ledger/");
    expect(a.getAttribute("href")).toBe("/ledger/");
    expect(() => {
      setAttr(a, "href", SCRIPT_URL);
    }).toThrow();
    expect(() => h("img", { attrs: { src: SCRIPT_URL } })).toThrow();
  });
});

describe("rich()", () => {
  it("turns *words* into <strong> and keeps everything else as text", () => {
    const parts = rich("Paid *straight to your wallet*, <b>no</b> fee");
    const p = h("p", null, parts);
    expect(p.querySelectorAll("strong")).toHaveLength(1);
    expect(p.querySelector("strong")?.textContent).toBe("straight to your wallet");
    expect(p.querySelector("b")).toBeNull();
    expect(p.textContent).toBe("Paid straight to your wallet, <b>no</b> fee");
  });
});
