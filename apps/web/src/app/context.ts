// SPDX-License-Identifier: MIT
/** What every page receives: the edition, the registry, configuration, translations, the device store and the session. */
import type { ChainDefinition, Registry } from "@paylink/chains";
import type { Locale, Translator } from "@paylink/i18n";
import type { ChainClient } from "../core/clients.ts";
import type { RuntimeConfig } from "../core/config.ts";
import type { SiteLocation } from "../core/links.ts";
import type { EditionProfile } from "../editions/types.ts";
import type { DeviceStore } from "../store/db.ts";
import type { Session } from "./session.ts";

export interface App {
  readonly edition: EditionProfile;
  readonly registry: Registry;
  readonly config: RuntimeConfig;
  /** Why `/config.json` was rejected, when it was (the defaults are then in use). */
  readonly configProblem: string | null;
  readonly i18n: Translator;
  readonly locale: Locale;
  readonly store: DeviceStore;
  readonly session: Session;
  readonly site: SiteLocation;
  /** True when the page is inside a frame: payments stay locked (threat T-06). */
  readonly framed: boolean;
  client(chain: ChainDefinition): ChainClient;
}
