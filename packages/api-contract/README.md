# @paylink/api-contract

The public contract of the PayPal edition's API ([`apps/api`](../../apps/api/README.md); [docs/paypal/SPEC.md](../../docs/paypal/SPEC.md) §13, [ADR 0018](../../docs/adr/0018-paypal-edition.md)): the route table, the request and response types of every route, the RFC 9457 problem codes, and the enumerations the web edition shows (PayPal's 16 invoice statuses and their classes, rails, chain states, situations S0–S9, proposal kinds). Types and constants only, **no dependency and no side effect**, so `apps/web` imports it without pulling any server code into a page.

```ts
import { API_ROUTES, statusClassOf, type TwinView, type ApiProblem } from "@paylink/api-contract";
```

| Module | Holds | Owner |
|---|---|---|
| [`src/common.ts`](src/common.ts) | `API_ROUTES` (method, path, auth, owner), headers, `API_PROBLEMS`, PayPal statuses and classes, rails, chain states, situations, proposal kinds, the edition's chain id (11155111) | foundation |
| [`src/session.ts`](src/session.ts) | the EIP-712 `PayLinkSession` domain and types, `POST /v1/session` | reconciler |
| [`src/twin.ts`](src/twin.ts) | `POST /v1/twin`, `GET /v1/twin/:key`, `GET /v1/rails/:key` | PayPal spine |
| [`src/desk.ts`](src/desk.ts) | the desk: proposals, auto-records, alerts, approve, reject, undo | reconciler (the AI workstream fills the assistant message) |
| [`src/check.ts`](src/check.ts) | `POST /v1/check`, the deterministic verdict | reconciler |
| [`src/ai.ts`](src/ai.ts) | `POST /v1/ai/draft` (A1) | AI |
| [`src/health.ts`](src/health.ts) | `GET /v1/health` | foundation |

Rules: the server validates every body with zod schemas built to these types, the client never parses `detail` (it branches on `code` and `rule`), and a change that breaks a consumer is a handoff to that consumer's workstream ([docs/paypal/SPEC.md](../../docs/paypal/SPEC.md), "Ownership"). `API_CONTRACT_VERSION` is bumped on any incompatible change. [`test/contract.test.ts`](test/contract.test.ts) checks the PayPal statuses against the vendored OpenAPI file and the route table against the specification's cuts.

```sh
pnpm --filter @paylink/api-contract run typecheck
pnpm --filter @paylink/api-contract run lint
pnpm --filter @paylink/api-contract run test
```
