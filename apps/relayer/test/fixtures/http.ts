// SPDX-License-Identifier: MIT
/** HTTP helpers for the relayer suites. */

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export async function call(base: string, path: string, init: { readonly method?: string; readonly body?: unknown; readonly headers?: Record<string, string>; readonly raw?: string } = {}): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined && init.raw === undefined ? "GET" : "POST"),
    headers: { ...(init.body === undefined && init.raw === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    ...(init.raw !== undefined ? { body: init.raw } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

export const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> => await call(base, path, { body, headers });
