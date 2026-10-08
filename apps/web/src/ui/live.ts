// SPDX-License-Identifier: MIT
/**
 * Announcements and transient UI: one polite live region for confirmations that are otherwise only visual (v1's
 * announcer), a toast, the print area, and clipboard copies that always come from canonical state (threat T-29).
 */
import { h, replace } from "./h.ts";

let region: HTMLElement | null = null;

/** Says `message` once through the polite live region. */
export function announce(message: string): void {
  if (region === null) {
    region = h("span", { class: "sr-only", attrs: { role: "status", "aria-live": "polite" } });
    document.body.append(region);
  }
  const target = region;
  target.textContent = "";
  window.setTimeout(() => {
    target.textContent = message;
  }, 60);
}

let toastTimer = 0;

/** A short-lived dark strip at the bottom of the screen; `action` adds one key. Also announced. */
export function toast(message: string, action?: { readonly label: string; readonly run: () => void }, ms = 6000): void {
  document.querySelector(".toast")?.remove();
  window.clearTimeout(toastTimer);
  const element = h(
    "div",
    { class: "toast", attrs: { role: "status" } },
    h("span", null, message),
    action === undefined
      ? null
      : h("button", { class: "key", attrs: { type: "button" }, on: { click: () => { element.remove(); action.run(); } } }, action.label),
  );
  document.body.append(element);
  if (action === undefined) {
    toastTimer = window.setTimeout(() => {
      element.remove();
    }, ms);
  }
}

/**
 * Copies `text` (computed from state by the caller, never read back from the DOM) and flips the key to its done
 * label for a moment.
 */
export async function copyText(text: string, key: HTMLElement, labels: { readonly idle: string; readonly done: string; readonly said: string }): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false;
  }
  announce(labels.said);
  key.textContent = labels.done;
  key.classList.add("is-done");
  window.setTimeout(() => {
    key.textContent = labels.idle;
    key.classList.remove("is-done");
  }, 1600);
  return true;
}

/** Prints one element: a clone goes into `#print-area` (sized 80 mm or A6), the rest of the page is hidden by CSS. */
export function printElement(element: HTMLElement, size: "80mm" | "a6"): void {
  let area = document.getElementById("print-area");
  if (area === null) {
    area = h("div", { attrs: { id: "print-area", "aria-hidden": "true" } });
    document.body.append(area);
  }
  area.setAttribute("data-size", size);
  replace(area, element.cloneNode(true));
  const target = area;
  const done = (): void => {
    target.replaceChildren();
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
}

/** Saves text as a file (CSV export, JSON backup) through a blob URL, revoked right after. */
export function download(filename: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h("a", { attrs: { href: url, download: filename } });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
