// SPDX-License-Identifier: MIT
/**
 * Structured logs: one JSON object per line, `{ ts, level, event, ...fields }` (Workers Logs in production, stdout in
 * Node). What is never logged (docs/paypal/SPEC.md §12.1, §9.4): request headers, request or webhook bodies, the PayPal
 * token or secret, HMAC keys, session or approval tokens, prompt bodies and pasted messages. Fields are allowlisted by
 * the call sites; on top of that, field names that can only hold such material are dropped, and every known secret
 * value is scrubbed from the serialised line.
 *
 * Owner: foundation.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined | readonly string[];
export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names that can only carry secrets, tokens, signatures or user text: dropped whatever their value. */
const FORBIDDEN_FIELD = /(?:secret|token|password|authorization|cookie|signature|^sig$|hmac|body|prompt|message|text|email|header)/iu;

export interface LoggerOptions {
  readonly sink: (line: string) => void;
  /** Secret values to scrub from every line. Values shorter than 12 characters are ignored. */
  readonly secrets?: readonly (string | undefined)[];
  readonly minLevel?: LogLevel;
  readonly base?: LogFields;
  readonly now?: () => number;
}

function scrubber(secrets: readonly (string | undefined)[]): (line: string) => string {
  const needles = [...new Set(secrets.filter((s): s is string => s !== undefined && s.length >= 12))];
  return (line) => needles.reduce((out, needle) => out.split(needle).join("[redacted]"), line);
}

export function createLogger(options: LoggerOptions): Logger {
  const scrub = scrubber(options.secrets ?? []);
  const min = LEVELS[options.minLevel ?? "info"];
  const now = options.now ?? Date.now;
  const make = (base: LogFields): Logger => ({
    log(level, event, fields = {}) {
      if (LEVELS[level] < min) {
        return;
      }
      const kept: Record<string, LogValue> = {};
      for (const [name, value] of Object.entries({ ...base, ...fields })) {
        if (value !== undefined && !FORBIDDEN_FIELD.test(name)) {
          kept[name] = value;
        }
      }
      options.sink(scrub(JSON.stringify({ ts: new Date(now()).toISOString(), level, event, ...kept })));
    },
    child(fields) {
      return make({ ...base, ...fields });
    },
  });
  return make(options.base ?? {});
}

/** A logger that writes nothing (tests). */
export const silentLogger: Logger = { log: () => undefined, child: () => silentLogger };

/** An error reduced to what may be logged: its class name and, for PayPal errors, status and code (never a body). */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    const paypalName = (error as { paypalName?: unknown }).paypalName;
    return {
      errorName: error.name,
      ...(typeof status === "number" ? { status } : {}),
      ...(typeof paypalName === "string" ? { paypalName } : {}),
    };
  }
  return { errorName: typeof error };
}
