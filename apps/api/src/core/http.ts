// SPDX-License-Identifier: MIT
/**
 * Request helpers for route handlers: the JSON body (size, media type and syntax already enforced, or a problem), and
 * zod validation that reports the first offending fields as `invalid-request`.
 *
 * Owner: foundation.
 */
import type { Context } from "hono";
import type { z } from "zod";
import { ProblemError } from "./problem.ts";

/** Reads the request body as text, refusing more than `limit` bytes (`payload-too-large`). */
export async function readText(c: Context, limit: number): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new ProblemError("payload-too-large", `the body may not exceed ${String(limit)} bytes`);
  }
  // Streamed with an early stop: a client that lies about (or omits) Content-Length cannot make the API buffer more.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const body = c.req.raw.body;
  if (body !== null) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ProblemError("payload-too-large", `the body may not exceed ${String(limit)} bytes`);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ProblemError("invalid-json", "the body is not valid UTF-8");
  }
}

/** Reads and parses a JSON body of at most `limit` bytes. The media type must be `application/json`. */
export async function readJson(c: Context, limit: number): Promise<unknown> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(type)) {
    throw new ProblemError("unsupported-media-type", "send the body as application/json");
  }
  const text = await readText(c, limit);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProblemError("invalid-json", "the body is not valid JSON");
  }
}

/** Validates `value` with `schema`; the first five issues are reported as JSON paths. */
export function parseBody<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.length === 0 ? "$" : `$.${issue.path.map(String).join(".")}`, message: issue.message }));
  throw new ProblemError("invalid-request", "the body does not match the schema", { issues });
}

/** A JSON response with the API's caching rule (never cached unless the route says so). */
export function json(c: Context, body: unknown, status: 200 | 201 | 202 = 200): Response {
  return c.json(body as object, status);
}
