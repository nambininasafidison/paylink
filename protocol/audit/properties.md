# Halmos, Echidna and Medusa: harnesses and recorded runs

> Self-review evidence, **not a third-party audit**. PAYLINK-V2-SPEC §4.1 lists Echidna 2.2.7, Medusa 1.3.1 (1 hour each, on the same property contract) and Halmos 0.3.3 (conservation and the state machine only, never presented as a proof about signatures) as nightly, non-blocking evidence. This file records what exists and what was run. The nightly workflow that would repeat these runs for an hour each (`fuzz-nightly.yml`) is not built yet (*planned (T1)*); until it is, the runs below, made in the sandbox on 2026-10-07, are the only evidence.

| Tool | Harness | What it checks | Result on this tree |
|---|---|---|---|
| Halmos 0.3.3 | `test/symbolic/PayLinkSymbolic.t.sol`, `test/symbolic/SymbolicMocks.sol` | Bounded symbolic proofs: conservation and exact payee credit on all four settlement paths for any token behaviour; the `pay` and `cancel` state machines from any stored state; a cancelled link refuses every path | **7 of 7 checks pass** (12.8 s of solving; under a minute with compilation); they kill 21 of the 23 mutants in their scope |
| Echidna 2.2.7 | `test/properties/PayLinkProperties.sol` (+ `PropertyMocks.sol`, `echidna.yaml`) | I1–I11 and `SelfPayment`, 12 properties | **12 of 12 hold** after 88,149 calls in 20 min (2 workers) |
| Medusa 1.3.1 | the same property contract (`medusa.json`) | the same 12 properties | **12 of 12 hold** after 935,655 calls in 20 min (2 workers) |
| Harness liveness | `test/properties/PayLinkProperties.t.sol` (runs on every `forge test`) | every payment path settles through the harness; every refusal the properties rely on happens | 2 of 2 pass |

## Install (pinned in `scripts/toolchain/pins.env`)

```bash
source scripts/toolchain/pins.env   # from the repository root; then put the three tools on PATH
# Echidna and Medusa: static release binaries (sha256 in pins.env, trust-on-first-use on 2026-10-07)
curl -sSLO "$PAYLINK_ECHIDNA_LINUX_AMD64_URL"; echo "$PAYLINK_ECHIDNA_LINUX_AMD64_SHA256  echidna-2.2.7-x86_64-linux.tar.gz" | sha256sum -c
curl -sSLO "$PAYLINK_MEDUSA_LINUX_AMD64_URL";  echo "$PAYLINK_MEDUSA_LINUX_AMD64_SHA256  medusa-linux-x64.tar.gz" | sha256sum -c
# Halmos: its own venv
python3 -m venv ~/.paylink-toolchain/halmos && ~/.paylink-toolchain/halmos/bin/pip install "halmos==$PAYLINK_HALMOS_VERSION"
```

Echidna and Medusa compile through crytic-compile (in the Slither venv that `scripts/bootstrap-sandbox.sh` installs) with `--foundry-compile-all`, because the property contract lives under `test/`. Run everything from `protocol/` with `~/.paylink-toolchain/env.sh` loaded. Corpora and coverage go to `cache/`, crytic-compile's export to `crytic-export/` (both ignored by git). Medusa resolves the paths in `medusa.json` from the config file's folder, hence the `../../` prefixes; they were added after the recorded run below, which had left its corpus under `test/properties/` (the fuzzing settings are unchanged).

## Halmos: conservation and the state machine

```bash
pnpm run symbolic   # halmos --match-contract PayLinkSymbolicTest --solver-timeout-assertion 0
```

Every `check_` parameter is symbolic, so each check covers all its values, within Halmos's bounds (no loops on these paths, so no unrolling bound is reached):

| Check | Property | Paths |
|---|---|---|
| `check_payWithAuthorization_conservesAndCreditsExactly` | For every amount, stray balance, payee balance and token behaviour in which the receive leg and the forward leg each debit and credit any amount (below 2^128) more or less than asked, a payment that succeeds leaves PayLink's balance exactly where it was (I1) and credits the payee exactly `amount` (I6) | 187 |
| `check_pay_conservesAndCreditsExactly` | The same on the allowance path, the pull leg skewed arbitrarily | 41 |
| `check_payWithPermit_conservesAndCreditsExactly` | The same on the permit path (the `try` fails on a token without `permit`, the standing allowance pays) | 41 |
| `check_payNative_conservesAndCreditsExactly` | The same in native coin, with forced ether already held by PayLink | 7 |
| `check_pay_stateMachine` | From any stored link state (`payments`, `cancelled`, `lastPaidAt`, `total`), for any invoice terms (amount, window, cap), time and amount: `pay` succeeds **if and only if** the shape, cancellation, window, cap and amount rules hold and neither `payments` nor `total` would overflow; on success the state becomes exactly (payments + 1, not cancelled, now, total + amount) and the payee is credited; on failure nothing changes | 215 |
| `check_cancel_stateMachine` | From any stored state: `cancel` succeeds **if and only if** the invoice is well formed, the caller is the payee and the link is not cancelled yet; the payee as mere `tx.origin` of a stranger's call authorizes nothing; only `cancelled` changes | 19 |
| `check_cancelledLinkRefusesEveryPath` | A cancelled link refuses all four payment paths, whatever the amount and the time (I4) | 7 |

**Scope, stated plainly.** The payee is `AcceptAll1271` (ERC-1271 accepting every hash), so no ECDSA is executed symbolically, and `SymbolicToken` checks no EIP-3009 signature. These checks say nothing about signatures, domains or nonce binding (I7, I8), which the unit, fuzz and invariant suites cover. `SymbolicToken`'s `balanceOf` tells the truth; a token that lies about balances is outside every guarantee PayLinkV2 makes.

**Raw output** (2026-10-07, Halmos 0.3.3, z3 from its wheel, solc 0.8.30, this tree):

```
Running 7 tests for test/symbolic/PayLinkSymbolic.t.sol:PayLinkSymbolicTest
[PASS] check_cancel_stateMachine((uint32,bool,uint64,uint128),uint64,uint64,bool) (paths: 19, time: 0.46s, bounds: [])
[PASS] check_cancelledLinkRefusesEveryPath(uint8,uint128,uint64) (paths: 7, time: 0.22s, bounds: [])
[PASS] check_payNative_conservesAndCreditsExactly(uint128,uint128,uint128) (paths: 7, time: 0.07s, bounds: [])
[PASS] check_payWithAuthorization_conservesAndCreditsExactly(uint128,uint128,uint128,uint128,uint128,uint128,uint128,uint8) (paths: 187, time: 3.55s, bounds: [])
[PASS] check_payWithPermit_conservesAndCreditsExactly(uint128,uint128,uint128,uint128,uint128,uint8) (paths: 41, time: 0.56s, bounds: [])
[PASS] check_pay_conservesAndCreditsExactly(uint128,uint128,uint128,uint128,uint128,uint8) (paths: 41, time: 0.81s, bounds: [])
[PASS] check_pay_stateMachine((uint32,bool,uint64,uint128),(uint128,uint64,uint64,uint32),uint128,uint64) (paths: 215, time: 7.08s, bounds: [])
Symbolic test result: 7 passed; 0 failed; time: 12.82s
```

### Mutants (the hand-written catalogue, `mutation/mutants.py`)

Halmos was run, each in a scratch copy, against the 23 catalogue mutants that change an outcome these checks constrain (conservation, exact credit, a state transition or its rules). Mutants whose only effect is the error reported (M29, the precedence mutants), or that touch what the checks fix by construction (the payer is never the payee, the token is never PayLink, `statesOf`, events, signatures, re-entrancy), are left to the Foundry suites:

| Result | Mutants |
|---|---|
| Killed by `check_pay_stateMachine` | M02, M03, M04, M05, M07, M08, M33, M44, M45; with `check_cancel_stateMachine` also M18 |
| Killed by `check_cancelledLinkRefusesEveryPath` and `check_pay_stateMachine` | M01 |
| Killed by `check_cancel_stateMachine` | M14, M38, M55 (`cancel` accepting `tx.origin == payee`) |
| Killed by the conservation checks | M11, M50, M54 (EIP-3009); M13, M53 (forward leg); M12, M52 (`pay` and `payWithPermit`) |
| **Survived: M10, M51** | Dropping the receive check, or making it one-sided. Not a gap in the checks: with the conservation post-check and the forward-leg payee check in place, a wrong receipt still reverts, so conservation and exact credit hold; only the reported error changes (`ReceivedMismatch(amount, received)` from the receive check becomes the post-check's `ReceivedMismatch(before, after)` or `PayeeShortPaid`). Halmos checks outcomes, not error data; the documented error is pinned by `PayWithAuthorization.t.sol::test_RevertWhen_TokenTakesFeeOnReceive` and `test_RevertWhen_PayLinkReceivesMoreThanAuthorized` (both kill M10 and M51 in the Foundry suite). The receive check is therefore diagnostic defence in depth, which this run proves rather than assumes |

## Echidna and Medusa: I1–I11 on one property contract

```bash
pnpm run fuzz:echidna   # echidna . --contract PayLinkProperties --config test/properties/echidna.yaml (1 hour)
pnpm run fuzz:medusa    # medusa fuzz --config test/properties/medusa.json (1 hour)
```

`PayLinkProperties` uses no cheatcode, so both fuzzers run it unchanged:

- **Actors.** Three `PropertyActor` contracts are the payers and the payees. As payees they are deployed ERC-1271 accounts that accept exactly the digests they approved, so PayLinkV2's signature check runs for real; the link id, the cancel digest and the EIP-3009 nonce are recomputed in the harness from the EIP-712 definitions, independently of PayLinkV2.
- **Assets.** `stdToken` (standard), `skewToken` (`reconfigureSkew` makes one leg move up to 10^6 base units more or less than asked, or resets it: fee-on-transfer, charge-the-sender, over-credit and rebate are all reachable) and native coin (300 ether shared by the actors). EIP-3009 authorizations are the payer's on-chain approval of the exact tuple, so a relay that changes the amount, `payerRef` or `payerSalt` hits an unapproved tuple.
- **Actions.** `createInvoice` (open or fixed, windows that start up to a day ago or within six hours, caps 0–4, at most 24 invoices), `payWithAuthorization` (optionally tampered), `pay`, `payWithPermit`, `payNative`, `cancel` (by any actor), `cancelBySig` (approved by any actor, a quarter already expired), `replayOnAlternate` (payment or cancellation on a second deployment), `sendToPayLink` (plain transfer or unknown selector), `donate`, `reconfigureSkew`. The fuzzers choose block times (up to 6 hours between calls).
- **Properties.** `echidna_I1_conservation` … `echidna_I11_monotonicState` and `echidna_documentedChecksHold` (`SelfPayment`): each returns false once its invariant was violated by a call (per-call checks: PayLink's three balances unchanged across every call, in both directions; payee credited exactly the amount; payer debited exactly the amount on the standard token and in native; index sequential; no payment after a cancellation, outside the window or beyond the cap; only the payee cancels; replays and wrong paths refused) or when its state check fails (PayLink holds exactly the donations; `total` and `payments` equal the accepted payments; cancelled flags match; fixed invoices settle exactly their amount; the alternate deployment holds nothing).

### Recorded runs (2026-10-07, sandbox, 4 cores shared by both runs)

| | Echidna 2.2.7 | Medusa 1.3.1 |
|---|---|---|
| Budget | 20 min, 2 workers | 20 min, 2 workers |
| Calls | 88,149 | 935,655 (9,381 sequences of up to 100 calls) |
| Coverage | 16,704 unique instructions, corpus 26 | 1,374 branches hit, corpus 41 |
| Result | **12 of 12 properties hold** | **12 of 12 properties hold** |

These are first runs, shorter than the nightly hour the spec asks for; they establish that the harness works and finds nothing on this tree, not that an hour-long campaign would.

Echidna (last lines):

```
echidna_I2_paymentsNeverExceedMax: passing
echidna_I11_monotonicState: passing
echidna_I9_onlyPayeeCancels: passing
echidna_I8_authorizationBinding: passing
echidna_I7_domainSeparation: passing
echidna_documentedChecksHold: passing
echidna_I3_totalsMatchPayments: passing
echidna_I5_paymentsInsideWindow: passing
echidna_I6_exactness: passing
echidna_I10_pathSeparation: passing
echidna_I4_noPaymentAfterCancel: passing
echidna_I1_conservation: passing
Unique instructions: 16704
Unique codehashes: 4
Corpus size: 26
Seed: 87904975016021012
Total calls: 88149
```

Medusa (last lines):

```
fuzz: elapsed: 19m59s, calls: 935655 (795/sec), seq/s: 7, branches hit: 1374, corpus: 41, failures: 0/9381, gas/s: 121540877
Fuzzer stopped, test results follow below ...
[PASSED] Property Test: PayLinkProperties.echidna_I1_conservation()
[PASSED] Property Test: PayLinkProperties.echidna_I10_pathSeparation()
[PASSED] Property Test: PayLinkProperties.echidna_I11_monotonicState()
[PASSED] Property Test: PayLinkProperties.echidna_I2_paymentsNeverExceedMax()
[PASSED] Property Test: PayLinkProperties.echidna_I3_totalsMatchPayments()
[PASSED] Property Test: PayLinkProperties.echidna_I4_noPaymentAfterCancel()
[PASSED] Property Test: PayLinkProperties.echidna_I5_paymentsInsideWindow()
[PASSED] Property Test: PayLinkProperties.echidna_I6_exactness()
[PASSED] Property Test: PayLinkProperties.echidna_I7_domainSeparation()
[PASSED] Property Test: PayLinkProperties.echidna_I8_authorizationBinding()
[PASSED] Property Test: PayLinkProperties.echidna_I9_onlyPayeeCancels()
[PASSED] Property Test: PayLinkProperties.echidna_documentedChecksHold()
Test summary: 12 test(s) passed, 0 test(s) failed
lcov report(s) saved to: cache/medusa-corpus/coverage/lcov.info
```

### The harness catches real bugs (mutants)

A property campaign that cannot fail proves nothing, so each fuzzer was also run against catalogue mutants, each in a scratch copy with one worker and a short budget:

| Mutant | Change | Medusa: 150 s budget, 1 worker | Echidna: 300 s budget, 1 worker |
|---|---|---|---|
| M01 | drop the `Cancelled` check | killed in 37 s (wall, compilation included): I4 | not run |
| M04 | `SoldOut` off by one | killed in 51 s (wall, compilation included): I2 | killed: I2 |
| M06 | drop `SelfPayment` | killed in 41 s (wall, compilation included): I6, SelfPayment | not run |
| M07 | `total` overwritten, not accumulated | killed in 34 s (wall, compilation included): I3 | not run |
| M11 | drop the conservation post-check | killed in 51 s (wall, compilation included): I1 | not run |
| M12 | drop `_pullExact`'s payee check | killed in 32 s (wall, compilation included): I6 | not run |
| M13 | drop `_pushExact`'s payee check | killed in 47 s (wall, compilation included): I6 | not run |
| M14 | `cancel` without `NotPayee` | killed in 27 s (wall, compilation included): I9 | killed: I9 |
| M34 | `receive()` accepts native coin | killed in 30 s (wall, compilation included): I10, I1 | not run |
| M35 | `cancelBySig` without the already-cancelled check | killed in 37 s (wall, compilation included): I9 | not run |
| M50 | conservation post-check one-sided | killed in 77 s (wall, compilation included): I1 | killed: I1 |
| M52 | `_pullExact` one-sided | killed in 47 s (wall, compilation included): I6 | not run |
| M53 | `_pushExact` one-sided | killed in 33 s (wall, compilation included): I6 | **not found** (12,947 calls) |
| M54 | receive check and post-check both one-sided | killed in 40 s (wall, compilation included): I1 | not run |

Medusa found all fourteen within its budget. Echidna found three of the four it was given; at about 45 calls per second per worker in this sandbox (four runs sharing four cores) it did not reach `_pushExact`'s one-sided mutant (M53) in five minutes, which needs the forward leg's credit skewed and then a relayed payment on that token; the hour-long nightly budget is what the spec asks for. Echidna stops at its budget, not at the first failure, so no time to failure is reported for it.

Outside the harness's reach, by construction: M10 and M51 only change which error is reported (see Halmos above); the `tx.origin` mutants M55–M59 need a transaction origin other than the fuzzers' senders, which these fuzzers do not vary (the Foundry suite and campaign cover them); event-field mutants (M19, M39) need logs, which the harness does not decode (the Foundry campaign does).

## Regenerate

```bash
cd protocol && source ~/.paylink-toolchain/env.sh
pnpm run symbolic                                    # Halmos, about a minute
pnpm run fuzz:echidna                                # 1 hour (echidna.yaml); the runs above passed --timeout 1200
pnpm run fuzz:medusa                                 # 1 hour (medusa.json); the runs above passed --timeout 1200
forge test --match-path 'test/properties/*.t.sol'    # the harness is live
```

Echidna and Medusa recompile through crytic-compile, which leaves `out/` incomplete: run `forge build` (or `forge test`, which rebuilds) before anything that reads `out/`.
