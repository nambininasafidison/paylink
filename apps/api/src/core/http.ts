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

/** Like `readJson`, but an empty body (none, or zero bytes) reads as `{}` whatever its media type. */
export async function readOptionalJson(c: Context, limit: number): Promise<unknown> {
  const text = await readText(c, limit);
  if (text === "") {
    return {};
  }
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(type)) {
    throw new ProblemError("unsupported-media-type", "send the body as application/json");
  }
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

/**
 * The request's source for the per-source daily limits (threat T-60): the client IP Cloudflare's edge puts in
 * `CF-Connecting-IP` ("When no Worker subrequest is triggered, cf-connecting-ip reflects the client's IP address":
 * cloudflare/cloudflare-docs at 3fe915d, src/content/docs/fundamentals/reference/http-headers.mdx). An IPv6 address
 * counts by its /64 (one subscriber's prefix); an IPv4-mapped IPv6 address as its IPv4. Without the header (the Node
 * entry, tests), every request shares the source `unknown`. That a client cannot set the header itself on a
 * `workers.dev` route is UNVERIFIED (the page describes the edge-to-origin header).
 */
export function clientSource(c: Context): string {
  return sourceOf(c.req.header("cf-connecting-ip"));
}

export function sourceOf(header: string | undefined): string {
  const ip = (header ?? "").trim().toLowerCase();
  const v4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
  if (v4.test(ip)) {
    return ip;
  }
  if (!ip.includes(":") || ip.length > 45 || !/^[0-9a-f:.]+$/u.test(ip)) {
    return "unknown";
  }
  const halves = ip.split("::");
  if (halves.length > 2) {
    return "unknown";
  }
  const groupsOf = (part: string | undefined): string[] | null => {
    if (part === undefined || part === "") {
      return [];
    }
    const out: string[] = [];
    for (const g of part.split(":")) {
      if (v4.test(g)) {
        const [a = 0, b = 0, c2 = 0, d = 0] = g.split(".").map(Number);
        out.push(((a << 8) | b).toString(16), ((c2 << 8) | d).toString(16));
      } else if (/^[0-9a-f]{1,4}$/u.test(g)) {
        out.push(g);
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const tail = groupsOf(halves[1]);
  if (head === null || tail === null) {
    return "unknown";
  }
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return "unknown";
  }
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail].map((g) => Number.parseInt(g, 16));
  // ::ffff:a.b.c.d is an IPv4 client.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}
