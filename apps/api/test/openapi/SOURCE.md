# Vendored PayPal OpenAPI files

Copied byte for byte from <https://github.com/paypal/paypal-rest-api-specifications> at commit
`90e8041ffe02d80c452d2b476bedd59a8d219bdc` (2026-04-07; still the repository's `HEAD` on 2026-10-21), under the
repository's Apache License 2.0 (`LICENSE`, copied unchanged). PayPal publishes its REST API reference from these files.

| File | API | `info.version` | sha256 |
|---|---|---|---|
| `invoicing_v2.json` | Invoicing v2 (P2–P9, P12) | 2.6 | `b38ec179b0a904eed50825cd0b456e788569dc3fdb6efd08e131751f7cc19f52` |
| `notifications_webhooks_v1.json` | Webhooks Management v1 (P10, P11) | 1.11 | `4702a4c2601a087cdde7481f1b55800abb568906e50dde867bb958b4b25afecf` |
| `LICENSE` | Apache License 2.0 | — | `aca29b3892ad5c363440c50a618247cf50272b970e1862d837dcc8e1a37336d3` |

Both files list the sandbox server `https://api-m.sandbox.paypal.com` and the live server `https://api-m.paypal.com`.
The OAuth 2.0 token endpoint (P1, `POST /v1/oauth2/token`) is in neither file: its request and response were read from
the PayPal Agent Toolkit at `a3aa963` (`typescript/src/shared/client.ts` and the README's example response; not
vendored, the toolkit files that are vendored are in `../vendor/paypal-agent-toolkit-1.11.0/`).

`../openapi.test.ts` checks these checksums and validates the specification's request bodies with ajv; the PayPal spine
workstream extends it into the L0 suite (every outgoing request and every recorded response). Do not edit the JSON:
replace it with a newer upstream copy and update this table.
