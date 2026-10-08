// SPDX-License-Identifier: MIT
/** The edition's passkey layer, when it has one (the Monad edition), without loading the KeyCard or the layer. */
import type { PasskeyLayer } from "../accounts/passkey.ts";
import type { App } from "./context.ts";

export function passkeyLayerOf(app: Pick<App, "edition">): PasskeyLayer | null {
  const layer = app.edition.accountLayers.find((l) => l.kind === "passkey");
  return layer === undefined ? null : (layer as PasskeyLayer);
}
