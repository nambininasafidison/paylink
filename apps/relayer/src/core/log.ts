// SPDX-License-Identifier: MIT
/**
 * Structured logs: one JSON object per line, `{ ts, level, event, ...fields }`, written to the platform's log sink
 * (Workers Logs / `wrangler tail` in production, stdout in Node).
 *
 * What is never logged (THREAT_MODEL T-38, A7):
 * - the relayer key: the logger is given every secret it knows and replaces any occurrence in a line, with or
 *   without `0x`, whatever field carried it; fields whose name denotes key material or a signature are dropped;
 * - signatures and request bodies: fields are allowlisted by the call sites, never a whole body;
 * - client IP addresses: requesters appear as `requesterTag`, a truncated SHA-256 of the requester identity under a
 *   salt drawn at random per isolate and never stored, so tags cannot be linked across restarts or reversed by
 *   enumerating the IPv4 space.
 */
import { bytesToHex, sha256, stringToBytes } from "viem";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined | readonly string[];
export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names that can only hold key material or signatures: dropped whatever their value. */
const FORBIDDEN_FIELD = /(?:private|secret|mnemonic|seed|password|signature|payeeSig|^pk$|^sig$|^raw|^r$|^s$|^v$)/iu;

export interface LoggerOptions {
  /** Receives each serialised line. */
  readonly sink: (line: string) => void;
  /** Secrets to scrub from every line (the relayer key). Strings shorter than 16 characters are ignored. */
  readonly secrets?: readonly string[];
  readonly minLevel?: LogLevel;
  readonly base?: LogFields;
  /** Milliseconds since the epoch (tests pin it). */
  readonly now?: () => number;
}

function scrubber(secrets: readonly string[]): (line: string) => string {
  const needles = [...new Set(secrets.filter((secret) => secret.length >= 16).flatMap((secret) => [secret, secret.replace(/^0x/iu, "")]))]
    .filter((needle) => needle.length >= 16)
    .map((needle) => needle.toLowerCase());
  if (needles.length === 0) {
    return (line) => line;
  }
  return (line) => {
    let out = line;
    for (const needle of needles) {
      let at = out.toLowerCase().indexOf(needle);
      while (at !== -1) {
        out = `${out.slice(0, at)}[redacted]${out.slice(at + needle.length)}`;
        at = out.toLowerCase().indexOf(needle);
      }
    }
    return out;
  };
}

export function createLogger(options: LoggerOptions): Logger {
  const min = LEVELS[options.minLevel ?? "info"];
  const scrub = scrubber(options.secrets ?? []);
  const now = options.now ?? Date.now;
  const make = (base: LogFields): Logger => ({
    log(level, event, fields = {}) {
      if (LEVELS[level] < min) {
        return;
      }
      const record: Record<string, LogValue> = { ts: new Date(now()).toISOString(), level, event };
      for (const [key, value] of Object.entries({ ...base, ...fields })) {
        if (value !== undefined && !FORBIDDEN_FIELD.test(key) && !(key in record)) {
          record[key] = value;
        }
      }
      options.sink(scrub(JSON.stringify(record)));
    },
    child(fields) {
      return make({ ...base, ...fields });
    },
  });
  return make(options.base ?? {});
}

/** A logger that discards everything. */
export const silentLogger: Logger = { log: () => undefined, child: () => silentLogger };

/** Per-isolate salt for requester tags: random, in memory only. Drawn on first use: workerd forbids randomness at global scope. */
let tagSalt: string | undefined;

/** A short, unlinkable tag for a requester identity (never the IP itself). */
export function requesterTag(requester: string): string {
  tagSalt ??= bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  return sha256(stringToBytes(`${tagSalt}|${requester}`)).slice(2, 14);
}

/** The message of an unknown thrown value, bounded, for logs (never a stack with arguments). */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
