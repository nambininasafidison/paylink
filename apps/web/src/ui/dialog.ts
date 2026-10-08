// SPDX-License-Identifier: MIT
/**
 * A modal panel on the native `<dialog>` element (focus is trapped and Escape closes it natively; focus returns to the
 * opener). Used for the wallet picker.
 */
import { h } from "./h.ts";
import type { Child } from "./h.ts";

export interface Modal {
  readonly element: HTMLDialogElement;
  close(): void;
}

export function openModal(title: string, closeLabel: string, ...body: Child[]): Modal {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `dialog-${String(Date.now())}`;
  const element = h(
    "dialog",
    { class: "modal", attrs: { "aria-labelledby": titleId } },
    h(
      "div",
      { class: "device modal-device" },
      h("div", { class: "plate" }, h("span", null, h("i", { class: "led", attrs: { "aria-hidden": "true" } }), h("span", { attrs: { id: titleId } }, title))),
      h("div", { class: "view" }, ...body),
      h("div", { class: "modal-foot" }, h("button", { class: "key key-line", attrs: { type: "button" }, on: { click: () => { element.close(); } } }, closeLabel)),
    ),
  );
  element.addEventListener("close", () => {
    element.remove();
    opener?.focus();
  });
  element.addEventListener("click", (event) => {
    // A click on the backdrop (the dialog box itself, outside its panel) closes it.
    if (event.target === element) {
      element.close();
    }
  });
  document.body.append(element);
  element.showModal();
  return { element, close: () => { element.close(); } };
}
