// SPDX-License-Identifier: MIT
/**
 * A modal panel on the native `<dialog>` element (focus is trapped and Escape closes it natively; focus returns to the
 * opener). Used for the wallet picker and the KeyCard. The close key sits on the panel's plate, which stays at the top
 * of a panel that scrolls, so it is in view whatever the panel holds (a phone shows only part of the KeyCard at once).
 */
import { h } from "./h.ts";
import type { Child } from "./h.ts";

export interface Modal {
  readonly element: HTMLDialogElement;
  close(): void;
}

let sequence = 0;

export function openModal(title: string, closeLabel: string, ...body: Child[]): Modal {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  sequence += 1;
  const titleId = `dialog-${String(sequence)}`;
  const element = h(
    "dialog",
    { class: "modal", attrs: { "aria-labelledby": titleId } },
    h(
      "div",
      { class: "device modal-device" },
      h(
        "div",
        { class: "plate modal-plate" },
        h("span", null, h("i", { class: "led", attrs: { "aria-hidden": "true" } }), h("span", { attrs: { id: titleId } }, title)),
        h("button", { class: "key key-text modal-close", attrs: { type: "button" }, on: { click: () => { element.close(); } } }, closeLabel),
      ),
      h("div", { class: "view" }, ...body),
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
