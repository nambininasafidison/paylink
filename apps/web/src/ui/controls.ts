// SPDX-License-Identifier: MIT
/**
 * Form controls in the terminal's grammar: the band selector (engraved chain labels, a laterite marker on the active
 * one, never brand colours), the segmented control (raised radio keys in a recessed track) and the confirmation box.
 * Keyboard behaviour follows the WAI-ARIA radio group pattern: one tab stop, arrow keys move and select.
 */
import { h } from "./h.ts";

export interface BandOption {
  readonly id: number;
  readonly label: string;
  /** Second engraved line: "Testnet · 10143", or why the band cannot be chosen. */
  readonly sub: string;
  readonly disabled: boolean;
}

export interface BandSelector {
  readonly element: HTMLElement;
  value(): number | null;
  set(id: number): void;
}

export function bandSelector(options: readonly BandOption[], selected: number | null, label: string, onChange: (id: number) => void): BandSelector {
  let current = selected;
  const buttons: HTMLButtonElement[] = [];
  const select = (id: number, focus: boolean): void => {
    const option = options.find((o) => o.id === id);
    if (option === undefined || option.disabled) {
      return;
    }
    current = id;
    for (const [i, button] of buttons.entries()) {
      const on = options[i]?.id === id;
      button.setAttribute("aria-checked", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
      if (on && focus) {
        button.focus();
      }
    }
    onChange(id);
  };
  const move = (from: number, step: number): void => {
    for (let k = 1; k <= options.length; k += 1) {
      const option = options[(from + step * k + options.length * k) % options.length];
      if (option !== undefined && !option.disabled) {
        select(option.id, true);
        return;
      }
    }
  };
  for (const [index, option] of options.entries()) {
    const button = h(
      "button",
      {
        class: "band",
        attrs: {
          type: "button",
          role: "radio",
          "aria-checked": option.id === current ? "true" : "false",
          "aria-disabled": option.disabled ? "true" : null,
          tabindex: option.id === current || (current === null && index === 0) ? 0 : -1,
          "data-chain": option.id,
        },
        on: {
          click: () => {
            select(option.id, false);
          },
          keydown: (event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index, -1);
            }
          },
        },
      },
      h("span", { class: "band-label" }, option.label),
      h("span", { class: "band-id" }, option.sub),
    );
    buttons.push(button);
  }
  const element = h("div", { class: "bands", attrs: { role: "radiogroup", "aria-label": label }, vars: { "--n": String(Math.max(1, Math.min(options.length, 4))) } }, buttons);
  return {
    element,
    value: () => current,
    set: (id) => {
      select(id, false);
    },
  };
}

export interface SegOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly sub?: string;
}

export interface Segmented<V extends string> {
  readonly element: HTMLFieldSetElement;
  value(): V;
}

/** Native radio inputs (so forms, keyboards and assistive technology behave natively), styled as raised keys. */
export function segmented<V extends string>(name: string, legend: string, options: readonly SegOption<V>[], selected: V, onChange: (value: V) => void): Segmented<V> {
  let current = selected;
  const element = h(
    "fieldset",
    { class: "field" },
    h("legend", null, legend),
    h(
      "div",
      { class: "seg", vars: { "--n": String(options.length) } },
      options.map((option) =>
        h(
          "label",
          null,
          h("input", {
            attrs: { type: "radio", name, value: option.value, checked: option.value === selected },
            on: {
              change: () => {
                current = option.value;
                onChange(option.value);
              },
            },
          }),
          h("span", null, option.label),
          option.sub === undefined ? null : h("span", { class: "seg-sub" }, option.sub),
        ),
      ),
    ),
  );
  return { element, value: () => current };
}

/** A confirmation the user must tick (for example "this link never expires"). */
export function confirmBox(text: string, onChange: (checked: boolean) => void): { readonly element: HTMLLabelElement; checked(): boolean } {
  const input = h("input", { attrs: { type: "checkbox" }, on: { change: () => { onChange(input.checked); } } });
  return { element: h("label", { class: "check" }, input, h("span", null, text)), checked: () => input.checked };
}
