# @paylink/sdk

The PayLink v2 client SDK: everything a payee, a payer, a relayer and a receipt checker need to produce and check the bytes that `PayLinkV2` accepts. Normative format: [PayLink Signed Invoice Format v2](../../docs/spec/paylink-invoice-v2.md); engineering spec: PAYLINK-V2-SPEC §3.5.

Isomorphic TypeScript (browser, Cloudflare Worker, Node ≥ 22.18), built on viem 2.57.3 and [`@paylink/chains`](../chains/README.md). No other runtime dependency.

## Modules

| Area | API | Spec |
|---|---|---|
| EIP-712 | `payLinkDomain`, `domainSeparator`, `invoiceStructHash`, `invoiceKey`, `invoiceTypedData`, `cancelDigest`, `cancelTypedData`, `receiveWithAuthorizationDigest` | §4, §5, §8.3, §9.2 |
| Invoices | `buildInvoice` (CSPRNG salt, NFC memo, uint53 rule, explicit confirmation for no expiry), `invoiceShapeIssue`, `invoiceKind`, `issuerWarnings` | §3, §13.1 |
| Payment binding | `paymentNonce` (EIP-3009 nonce bound to key, payer, amount, payerRef, payerSalt) | §8.2 |
| Signing | `signInvoice`, `signCancel`, `signReceiveAuthorization`, `signPermit`: every produced signature is verified before it is returned; `v` ∈ {0, 1} is normalised to {27, 28} | §6, §8.3, §9.2, §13.1 |
| Verification | `verifySignature`: the contract's dispatch (ECDSA without code, ERC-1271 with code, EIP-7702 delegation flagged); OpenZeppelin ECDSA rules (65 bytes, low s, no compact form) | §6 |
| URL codec | `encodeInvoiceFragment`, `decodeInvoiceFragment`, `encodeReceiptFragment`, `decodeReceiptFragment`, strict base64url, 140-byte packing | §10 |
| JSON | `toSignedInvoiceJson` / `parseSignedInvoiceJson`, relayer bodies (`toRelayPayRequest`, `parseRelayPayRequest`), cancellations, receipt references | §11 |
| Flows | `issueInvoice` (issuer), `authorizePayment` (gasless EIP-3009; requires the outstanding-authorisation assessment), `preparePermitPayment` (EIP-2612), call builders for every entry point and the exact-amount `approve` | §8, §13 |
| Retry safety | `recordOutstandingAuthorization`, `outstandingAuthorizationId`, `parseOutstandingAuthorization` (stored records are re-derived from the registry), `assessOutstanding` / `assessOutstandingAuthorization` (`live`, `consumed`, `cancelled`, `expired`), `resubmissionCall`, `prepareAuthorizationCancel` + `withCancellation` (receipt-verified), `readAuthorizationState`, `OutstandingAuthorizationStore` | §8.6 |
| Routing and gas | `selectPaymentPath` (PaymentRouter: resubmission only while an authorisation is live), `payerAccountKind` (any code, EIP-7702 included, is a smart account), `clampGasLimit` / `gasLimitFor` with the registry's bounds | spec §3.5, §3.3.6; §8.3 |
| Relayer | `checkRelayPayRequest` (payee with the contract's dispatch, payer with the token's dispatch, bound nonce; reports both accounts' code; the chain's relay margin on `validBefore` and `validUntil`), `checkRelayCancelRequest` (margin on `deadline`), `assertRelayWindow` (the pre-broadcast re-check), `RelayAdmissionLedger` (margin again on the relayer's clock; in-flight bounds per key, payee, payer and token; per-requester rate; penalties by cause, `REVERT_PENALTIES`; code policy; snapshot for Durable Object storage), `attributeRelayRevert` + `replayRevertData` (who caused a post-simulation revert, from chain evidence), `requesterFromIp` (IPv4 address or IPv6 /64) | §13.3 |
| State | `readLinkState`, `readLinkStates` (batches of 256), `predictPayment` (the contract's revert, predicted in its order), `linkStatus` | §7 |
| Receipts | `verifyReceipt`, `createReceiptVerifier`, `decodePaidLog`, `isPaymentForArmedInvoice` (till rule) | §12, §13.4 |
| Deployment integrity | `verifyDeploymentCode`: masked runtime hash, the seven EIP712 immutables recomputed from (chainId, address), ERC-5267 domain | §4.2 |
| Amounts | `parseAmount`, `formatAmount`, `formatAmountLocale` (exact `Intl`), `convertDecimals`: bigint only, never rounds silently | spec §3.9 |
| Errors | `decodeError`, `decodeRevertData`: PayLinkV2 and OpenZeppelin errors, FiatToken revert strings, panics, wallet and network failures → i18n key + named parameters; `SDK_I18N_KEYS` for `@paylink/i18n` | §7.6 |

## Decoding a link

```ts
import { registry, scopeToEdition } from "@paylink/chains";
import { decodeInvoiceFragment, decodeError, fragmentOf } from "@paylink/sdk";

try {
  const link = decodeInvoiceFragment(fragmentOf(location.href), scopeToEdition(registry, "monad"));
  // link.invoice, link.memo (untrusted: sanitizeMemoForDisplay), link.key, link.target.deployment, link.token
} catch (error) {
  const { i18nKey, params, name } = decodeError(error); // e.g. "error.link.chainUnknown", support code "E_CHAIN_UNKNOWN"
}
```

The decoder runs the twelve steps of §10.5 in order and stops at the first failure with its symbolic code (`E_FRAGMENT_TOO_LONG` … `E_TOKEN_UNKNOWN`). It never fetches, never percent-decodes, and checks the 1,200-character cap first. The contract address comes from the registry only.

## Paying gaslessly, and retrying safely

```ts
const id = outstandingAuthorizationId({ chainId: link.chainId, key: link.key, payer: payerAccount.address });
const stored = await store.get(id); // IndexedDB in the web client; untrusted input
const checked = stored === undefined ? null : parseOutstandingAuthorization(stored, registry);
const outstanding = checked === null ? null : await assessOutstanding({ client, checked, now: chainTime });

const route = selectPaymentPath({ capabilities: link.token.capabilities, account, relayerHealthy, outstanding });
if (outstanding?.state === "live") {
  // A retry: send the very same body again (relayer), or resubmissionCall(checked) with the payer's gas. Never re-sign.
} else {
  const payment = await authorizePayment({ link, signer: payerAccount, now: chainTime, client, outstanding });
  await store.put(id, recordOutstandingAuthorization(link, payment)); // before it leaves the device
  await fetch(`/v1/${link.chainId}/pay`, { method: "POST", body: JSON.stringify(payment.request) }); // the memo is never sent
}
```

`authorizePayment` refuses to sign while an authorisation for the same link and payer is `live` (`E_AUTHORIZATION_OUTSTANDING`) or `consumed` without a recorded cancellation (`E_AUTHORIZATION_CONSUMED`, unless `newPayment: true`): PayLinkV2 does not deduplicate across authorisations, so a second signature would be a second payment on a receive card, a till or an N-seat link ([spec §8.6](../../docs/spec/paylink-invoice-v2.md#86-retries-and-outstanding-authorisations)). To switch to permit or approve-and-pay while one is live, send `prepareAuthorizationCancel(...).call` from the payer and record it with `withCancellation(checked, txHash, receipt)`, which requires the token's `AuthorizationCanceled(payer, nonce)` in a successful receipt (a cancel that lost the race to the relayer reverts, and the payment went through); otherwise wait for `validBefore`.

The relayer parses the body with `parseRelayPayRequest`, checks it with `checkRelayPayRequest` at `now` = the timestamp of the block it simulates against (requests whose time bounds end within the chain's relay margin are refused with rule `RelayValidityTooShort`), admits it with `RelayAdmissionLedger.admit(checked, requesterFromIp(clientIp), clock)`, simulates against the pending block and re-checks `assertRelayWindow` with its timestamp, then sends `payWithAuthorizationCall` with `gasLimitFor(chain, "payWithAuthorization", estimate)`. An estimate above the ceiling is refused (`E_GAS_ABOVE_CEILING`) instead of being clamped into a certain out-of-gas failure. It releases the ticket with the outcome: `"settled"`, `"dropped"` (never included), or, for a transaction mined with status 0, the attribution of the revert:

```ts
const revertData = await replayRevertData({ client, from: relayer.address, call: checked.call, gas, blockNumber: receipt.blockNumber });
const attribution = await attributeRelayRevert({ client, registry, ticket, inclusion: { blockNumber: receipt.blockNumber, timestamp }, simulatedAt, revertData });
ledger.release(ticket, attribution, clock); // bans only the party the evidence names; a superseding settlement bans nobody
```

## Evidence

| Gate | Result |
|---|---|
| Golden vectors | `protocol/test/vectors/{eip712,nonce,cancel}.json` reproduced **byte for byte**: domain separators, struct hashes, keys, packed bytes, base64url, fragments, nonces, EIP-3009 digests, and the RFC 6979 signatures themselves (`test/vectors/golden.test.ts`) |
| Spec examples | §11.3 JSON example round-trips byte for byte; §17.3–§17.6 values reproduced (`test/spec-examples.test.ts`) |
| ABI | every function and error selector equals the tables of §7.6 and §17.2; equals the Foundry artifact when `protocol/out` exists |
| Property tests (fast-check) | base64url bijection; fragment encode → decode → encode identity; **injectivity** (changing any character fails or yields another link); only typed errors on arbitrary input; amounts at 6 and 18 decimals against viem; error decoder over every PayLinkV2 error |
| Deployment integrity | the TypeScript masked-hash and immutables check accepts the real release runtime code (captured from anvil) and rejects copied code |
| End to end | `test/integration/anvil.test.ts`: the release build of PayLinkV2 and the FiatToken-like mock on anvil's Monad emulation; issue → decode → authorize → relay with clamped gas → verify receipt → till rule; `payWithPermit`; a relayer that changes `payerRef` gets the token's signature failure (I8); `cancelBySig`; SoldOut and Cancelled decoded from real reverts; **relayer slow, then lands** (the retry resubmits, the late relay is refused, the payer is charged once); **cancel, then permit**; **one `cancel` under queued relays** reverts only the one admitted relay, and the attribution names the payee, who is banned with the card; a payer's cancelled authorisation bans the payer only; the payer's own resubmission landing first is `superseded` and bans nobody; a sold-out race bans the key only; a 1-second authorisation is refused and a relay mined past its margin bans nobody (audit finding A-04). Skipped when anvil or `protocol/out` is missing |
| Coverage | 100 % statements, functions and lines; ≥ 96 % branches (gate: 90 %) |

## Scripts

```bash
pnpm --filter @paylink/sdk run typecheck        # src/ with web-platform types only, then everything with Node types
pnpm --filter @paylink/sdk run lint
pnpm --filter @paylink/sdk run test:coverage
pnpm --filter @paylink/sdk run generate:check   # ABI drift (needs protocol/out)
pnpm --filter @paylink/sdk run measure:gas      # writes packages/chains/data/gas-measurements.json (needs anvil + protocol/out)
pnpm --filter @paylink/sdk run fixture:runtime  # regenerates test/fixtures/paylinkv2-runtime-31337.json (needs anvil + protocol/out)
```

Inside the workspace, packages resolve each other's TypeScript sources through the `@paylink/source` export condition; `pnpm run build` emits `dist/` (ES2023 modules with declarations) for consumers that do not use the condition.
