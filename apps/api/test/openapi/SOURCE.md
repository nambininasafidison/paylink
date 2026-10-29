# Vendored PayPal OpenAPI files

Copied byte for byte from <https://github.com/paypal/paypal-rest-api-specifications> at commit
`90e8041ffe02d80c452d2b476bedd59a8d219bdc` (2026-04-07; still the repository's `HEAD` on 2026-10-21), under the
repository's Apache License 2.0 (`LICENSE`, copied unchanged). PayPal publishes its REST API reference from these files.

| File | API | `info.version` | sha256 |
|---|---|---|---|
| `invoicing_v2.json` | Invoicing v2 (P2–P9, P12, P13) | 2.6 | `b38ec179b0a904eed50825cd0b456e788569dc3fdb6efd08e131751f7cc19f52` |
| `notifications_webhooks_v1.json` | Webhooks Management v1 (P10, P11, P14) | 1.11 | `4702a4c2601a087cdde7481f1b55800abb568906e50dde867bb958b4b25afecf` |
| `LICENSE` | Apache License 2.0 | — | `aca29b3892ad5c363440c50a618247cf50272b970e1862d837dcc8e1a37336d3` |

Both files list the sandbox server `https://api-m.sandbox.paypal.com` and the live server `https://api-m.paypal.com`,
and name `/v1/oauth2/token` as the `tokenUrl` of their `Oauth2` security scheme. The OAuth 2.0 token endpoint (P1)
itself, its request and its response, is in neither file: they were read from the PayPal Agent Toolkit at `a3aa963`
(`typescript/src/shared/client.ts` and the section "Generating an Access Token" of its `README.md`; not vendored, the
toolkit files that are vendored are in `../vendor/paypal-agent-toolkit-1.11.0/`).

## What checks them

- `../openapi.test.ts`: these checksums, the versions, the servers, that every operation of the client's table
  (`PAYPAL_OPERATIONS` in `src/paypal/client.ts`) exists with its method, and the specification's request bodies.
- `contract.ts` and `contract.test.ts` (L0, docs/paypal/SPEC.md §15.2): every request the PayPal client sends and every
  answer it parses, in success and in refusal, for P1–P11, P13 and P14, validated with ajv against the operation's
  schema while the client runs against the PayPal fake (`src/paypal/fake/`), under each of the fake's behaviours; and
  the bodies PayLink builds (`src/paypal/invoice.ts`) for any input the builder accepts (fast-check). P1 is checked with
  the client's own parser, which follows the toolkit's documented response.

`contract.ts` reads the files as they are and corrects two of their own defects in memory, and adds one answer of
PayPal's sandbox they do not list, and only those: `payment_reference.payment_id` writes its `minLength` and `maxLength`
as strings (`"1"`, `"22"`), which JSON Schema refuses; `verify_webhook_signature.transmission_sig` carries the pattern
`^(?!\d+$)\w+\S+`, which a base64 signature beginning with `+` or `/` would fail although that is what PayPal delivers in
`PAYPAL-TRANSMISSION-SIG`; and `invoices.remind-400` lists two issues, while the sandbox answered a reminder for an
invoice without a billing email with a third, `CANNOT_REMIND_AS_BILLING_INFO_ABSENT` (the owner's capture of 2026-10-29,
[`docs/research/paypal/capture-2026-10-29.md`](../../../../docs/research/paypal/capture-2026-10-29.md)), which is added to
that list. PayPal's own formats (`ppaas_*`) have no published definition and are checked by their patterns only.

Do not edit the JSON: replace it with a newer upstream copy and update this table.
