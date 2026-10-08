// SPDX-License-Identifier: MIT
/**
 * Runtime configuration: the same-origin `/config.json` (PAYLINK-V2-SPEC §3.6 "No URL-configurable endpoints").
 * It holds what may change without a rebuild: an incident banner, the relayer and indexer endpoints, and preferred
 * RPCs. Contract addresses and tokens never come from here (the registry is the only root of trust for addresses),
 * and every endpoint must also be listed in the Content-Security-Policy `connect-src` of `_headers`, which
 * `test/headers.test.ts` checks. The file is validated strictly; an invalid file is ignored in favour of the
 * built-in defaults, and the status page says so.
 */
import * as z from "zod/mini";

const httpsUrl = z.string().check(
  z.maxLength(200),
  z.refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
    } catch {
      return false;
    }
  }, "must be an https URL without credentials, query or fragment"),
);
const chainId = z.int().check(z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER));
const text = z.string().check(z.minLength(1), z.maxLength(400));

const endpoint = z.strictObject({
  url: httpsUrl,
  /** The chains it serves; others behave as if it were not configured. */
  chains: z.array(chainId).check(z.maxLength(32)),
});

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  /** Incident or maintenance notice shown on every page (docs/security/incident-response.md). */
  banner: z.nullable(
    z.strictObject({
      level: z.enum(["info", "warning", "critical"]),
      text: z.strictObject({ en: text, fr: z.optional(text), mg: z.optional(text) }),
    }),
  ),
  /** The gasless relayer (apps/relayer, tier T1). `null`: payers use their own wallet only. */
  relayer: z.nullable(endpoint),
  /** The history indexer (apps/indexer, tier T1). A cache only (ADR 0009): never consulted for payability. */
  indexer: z.nullable(endpoint),
  /** RPC endpoints tried before the registry's own, by chain ID. */
  rpc: z.record(z.string().check(z.regex(/^[1-9][0-9]{0,15}$/)), z.array(httpsUrl).check(z.maxLength(4))),
});

export type RuntimeConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: RuntimeConfig = Object.freeze({ version: 1, banner: null, relayer: null, indexer: null, rpc: {} });

export type ConfigLoad = { readonly ok: true; readonly config: RuntimeConfig } | { readonly ok: false; readonly config: RuntimeConfig; readonly problem: string };

/** Validates a parsed `config.json`. */
export function parseConfig(value: unknown): ConfigLoad {
  const result = ConfigSchema.safeParse(value);
  if (result.success) {
    return { ok: true, config: result.data };
  }
  const issue = result.error.issues[0];
  return { ok: false, config: DEFAULT_CONFIG, problem: issue === undefined ? "invalid" : `${issue.path.join(".")}: ${issue.message}` };
}

/** Fetches and validates `<base>config.json` (same origin, never cached by the service worker). */
export async function loadConfig(base: string, fetcher: typeof fetch = fetch): Promise<ConfigLoad> {
  try {
    const response = await fetcher(`${base}config.json`, { cache: "no-cache", credentials: "same-origin", headers: { accept: "application/json" } });
    if (!response.ok) {
      return { ok: false, config: DEFAULT_CONFIG, problem: `HTTP ${String(response.status)}` };
    }
    return parseConfig(await response.json());
  } catch (error) {
    return { ok: false, config: DEFAULT_CONFIG, problem: error instanceof Error ? error.message : "unreachable" };
  }
}

/** The endpoint when it serves `chainId`. */
export function endpointFor(endpointConfig: RuntimeConfig["relayer"], chainIdValue: number): string | null {
  return endpointConfig?.chains.includes(chainIdValue) === true ? endpointConfig.url : null;
}
