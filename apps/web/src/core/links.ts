// SPDX-License-Identifier: MIT
/**
 * Links this app hands out (invoice spec §10): `<origin><base>pay/#<fragment>` and `<origin><base>r/#<fragment>`. The
 * base (origin and edition path) is a deployment choice and is not signed; the fragment never reaches a server.
 */
import { withFragment } from "@paylink/sdk";

export interface SiteLocation {
  readonly origin: string;
  /** The edition base path, with leading and trailing slash ("/", "/monad/"). */
  readonly base: string;
}

export function payUrl(site: SiteLocation, fragment: string): string {
  return withFragment(`${site.origin}${site.base}pay/`, fragment);
}

export function receiptUrl(site: SiteLocation, fragment: string): string {
  return withFragment(`${site.origin}${site.base}r/`, fragment);
}

export function tillUrl(site: SiteLocation, fragment: string): string {
  return withFragment(`${site.origin}${site.base}till/`, fragment);
}

/** `https://wa.me/?text=…`: WhatsApp's documented share link, opened in a new tab (nothing is sent by the app). */
export function whatsappUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** Route path inside the edition ("/monad/ledger/"). */
export function routePath(base: string, route: "" | "pay/" | "r/" | "ledger/" | "send/" | "till/" | "status/"): string {
  return `${base}${route}`;
}
