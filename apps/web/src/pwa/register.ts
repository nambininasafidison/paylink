// SPDX-License-Identifier: MIT
/**
 * Service worker registration (PWA, spec §3.6) under Trusted Types: the production CSP requires a TrustedScriptURL for
 * `serviceWorker.register`, and the one policy the CSP allows (`paylink-sw`) returns only this edition's fixed
 * `sw.js` URL. A waiting worker is never activated behind the user's back: a toast offers the reload (the update
 * prompt), and the generated worker skips waiting only when asked.
 */
import type { App } from "../app/context.ts";
import { toast } from "../ui/live.ts";

interface TrustedTypesLike {
  createPolicy(name: string, rules: { createScriptURL(input: string): string }): { createScriptURL(input: string): unknown };
}

/** The `sw.js` URL of the edition, through the `paylink-sw` policy when Trusted Types exist. */
export function workerUrl(base: string): string {
  const url = `${base}sw.js`;
  const tt = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  if (tt === undefined) {
    return url;
  }
  const policy = tt.createPolicy("paylink-sw", {
    createScriptURL: (input) => {
      if (input !== url) {
        throw new TypeError("paylink-sw: only the edition's own service worker may be registered");
      }
      return input;
    },
  });
  return policy.createScriptURL(url) as string;
}

export function registerServiceWorker(app: App): void {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV || location.protocol !== "https:" && location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    return;
  }
  let requested = false;
  const offerReload = (worker: ServiceWorker): void => {
    toast(app.i18n.t("app.update"), {
      label: app.i18n.t("app.update.reload"),
      run: () => {
        requested = true;
        worker.postMessage({ type: "SKIP_WAITING" });
      },
    });
  };
  const start = (): void => {
    navigator.serviceWorker
      .register(workerUrl(app.site.base), { scope: app.site.base, type: "classic" })
      .then((registration) => {
        if (registration.waiting !== null && navigator.serviceWorker.controller !== null) {
          offerReload(registration.waiting);
        }
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller !== null) {
              offerReload(installing);
            }
          });
        });
      })
      .catch(() => {
        // No offline mode in this browser (or blocked): the app works online as before.
      });
    // Reload once the new worker controls the page, but only when the user asked for the update.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (requested) {
        requested = false;
        location.reload();
      }
    });
  };
  if (document.readyState === "complete") {
    start();
  } else {
    window.addEventListener("load", start, { once: true });
  }
}
