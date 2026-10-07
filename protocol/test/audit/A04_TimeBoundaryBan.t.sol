// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {IERC3009} from "../../src/interfaces/IERC3009.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @title AUDIT-04 regression: time bounds the relayer forwards, and what a revert on inclusion proves
/// @notice Finding A-04 (2026-10-07 re-audit, medium). The relayer admission policy (`checkRelayPayRequest`,
///         `checkRelayCancelRequest`, `RelayAdmissionLedger`; invoice spec §13.3) applied no minimum remaining validity
///         to the three time bounds a relayed call carries: the payer's EIP-3009 `validBefore` (chosen by the payer
///         alone), the invoice's `validUntil` and a cancellation's `deadline`. A bound one second ahead of the
///         simulated block passes every check and `eth_call`, then reverts in any later block: the attacker sends no
///         transaction and deploys no code, and on Monad the relayer pays the full gas limit. The ledger then banned
///         the invoice key, the payee and the payer whoever caused the revert, so a sybil payer holding one base unit
///         could shut an honest merchant out of the gasless path, and the same authorization landing first by another
///         route (the payer's own spec §8.6 resubmission, copied calldata) banned honest parties.
///         Status: by design on-chain; fixed in the relayer (packages/sdk). Every v2 chain carries a relay margin
///         (`chain.relay.minRemainingSeconds`, 120 s), applied at the check against the simulated block and again at
///         admission: a call is relayed only while its `validThrough` (the last block timestamp at which it passes its
///         time bounds) is at least `now + margin`. Reverts are attributed from chain evidence
///         (`attributeRelayRevert`) and only the party that caused one is banned (`REVERT_PENALTIES`); the same
///         authorization settling this payment elsewhere is `superseded` and bans nobody.
///         These tests pin the contract behaviour that policy rests on: the time bounds are exact at the second
///         (`_admissible` restates the SDK rule), and `payWithAuthorization` emits `Paid` immediately before the
///         token's `AuthorizationUsed`, the adjacency by which the SDK recognises a superseding settlement.
///         The SDK side is pinned by packages/sdk/test/audit/A04-time-boundary-ban.test.ts,
///         packages/sdk/test/relay-attribution.test.ts and the anvil suite.
/// @dev Run: forge test --match-path 'test/audit/A04_TimeBoundaryBan.t.sol' -vv
contract A04TimeBoundaryBanTest is BaseTest {
    /// @dev packages/chains/src/generated/gas.ts: EMULATED_GAS_LIMITS.monad floors (charged in full on Monad).
    uint256 internal constant MONAD_PAY_FLOOR = 224_000;
    uint256 internal constant MONAD_CANCEL_FLOOR = 89_000;
    /// @dev Monad minimum base fee, 100 MON-gwei (spec §3.3.6, C).
    uint256 internal constant MONAD_MIN_BASE_FEE = 100 gwei;
    /// @dev packages/chains DEFAULT_RELAY_TIMING.minRemainingSeconds: every v2 chain's relay margin.
    uint256 internal constant RELAY_MARGIN = 120;
    bytes32 internal constant REF = bytes32("A04");
    bytes32 internal constant AUTHORIZATION_USED_TOPIC = keccak256("AuthorizationUsed(address,bytes32)");

    // ------------------------------------------------------------------ relayer pipeline model (as in A02)

    function _simulate(bytes memory callData) internal returns (bool ok) {
        uint256 snapshot = vm.snapshotState();
        vm.prank(relayer);
        (ok,) = address(payLink).call(callData);
        vm.revertToState(snapshot);
    }

    function _send(bytes memory callData, uint256 gasLimit) internal returns (bool ok, bytes memory ret) {
        vm.prank(relayer);
        (ok, ret) = address(payLink).call{gas: gasLimit}(callData);
    }

    /// @dev Inclusion lands in a later block, `seconds_` later.
    function _includeAfter(uint256 seconds_) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + seconds_);
    }

    /// @dev The SDK's admission rule (`assertRelayWindow`), restated: `validThrough >= now + margin`.
    function _admissible(uint256 validThrough, uint256 now_) internal pure returns (bool) {
        return validThrough >= now_ + RELAY_MARGIN;
    }

    /// @dev `paymentValidThrough`: the earlier of `validBefore - 1` (FiatToken requires `now < validBefore`) and the
    ///      invoice's `validUntil` (inclusive) when it is set.
    function _paymentValidThrough(IPayLinkV2.Invoice memory inv, IPayLinkV2.Authorization memory auth)
        internal
        pure
        returns (uint256)
    {
        uint256 authorizationEnd = auth.validBefore - 1;
        return inv.validUntil != 0 && inv.validUntil < authorizationEnd ? inv.validUntil : authorizationEnd;
    }

    /// @dev An honest merchant's receive card: open amount, unlimited, no expiry. The merchant does nothing below.
    function _honestReceiveCard() internal returns (IPayLinkV2.Invoice memory card, bytes memory sig) {
        card = _invoiceN(address(usdc), 0, 0);
        card.validUntil = 0;
        sig = _signInvoice(card);
    }

    /// @dev Payer-signed authorization with an explicit `validBefore`.
    function _authorizeUntil(uint256 payerKey_, bytes32 key, uint128 amount, bytes32 salt, uint256 validBefore)
        internal
        view
        returns (IPayLinkV2.Authorization memory auth)
    {
        auth.payer = vm.addr(payerKey_);
        auth.amount = amount;
        auth.payerRef = REF;
        auth.payerSalt = salt;
        auth.validAfter = vm.getBlockTimestamp() - 1;
        auth.validBefore = validBefore;
        _signAuthorization(payerKey_, address(usdc), auth, _nonce(key, auth.payer, amount, REF, salt));
    }

    // ------------------------------------------------------------------ what the relayer must assume

    /// @notice A sybil payer with 1 base unit signs `validBefore = now + 1` for an honest merchant's receive card.
    ///         `eth_call` passes and the relay reverts one block later; the payee is an EOA and does nothing. The
    ///         margin refuses it before any gas is spent.
    function test_SimulationDoesNotBind_PayerChosenValidBefore() public {
        (IPayLinkV2.Invoice memory card, bytes memory sig) = _honestReceiveCard();
        (address sybil, uint256 sybilKey) = makeAddrAndKey("sybilPayer");
        usdc.mint(sybil, 1);

        IPayLinkV2.Authorization memory auth = _authorizeUntil(sybilKey, _key(card), 1, "s", vm.getBlockTimestamp() + 1);
        bytes memory callData = abi.encodeCall(payLink.payWithAuthorization, (card, sig, auth));
        assertTrue(_simulate(callData), "eth_call passes");
        assertFalse(_admissible(_paymentValidThrough(card, auth), vm.getBlockTimestamp()), "refused at admission");

        _includeAfter(1);
        (bool ok, bytes memory ret) = _send(callData, MONAD_PAY_FLOOR);
        assertFalse(ok, "included relay reverts");
        assertEq(
            keccak256(ret), keccak256(abi.encodeWithSignature("Error(string)", "FiatTokenV2: authorization is expired"))
        );
        assertEq(usdc.balanceOf(sybil), 1, "the attacker spent nothing");
        assertEq(payLink.stateOf(_key(card)).payments, 0);
        console.log(
            "relayer loss on Monad per grief without the margin (wei of MON):", MONAD_PAY_FLOOR * MONAD_MIN_BASE_FEE
        );
    }

    /// @notice The requester picks the invoice's last valid second: only the simulation looked at `validUntil`.
    function test_SimulationDoesNotBind_InvoiceLastSecond() public {
        IPayLinkV2.Invoice memory inv = _invoiceN(address(usdc), 0, 0);
        inv.validUntil = uint64(vm.getBlockTimestamp() + 7 days);
        bytes memory sig = _signInvoice(inv);
        (address sybil, uint256 sybilKey) = makeAddrAndKey("sybilPayer");
        usdc.mint(sybil, 1);

        vm.warp(inv.validUntil); // the invoice's last valid second (inclusive)
        IPayLinkV2.Authorization memory auth =
            _authorizeUntil(sybilKey, _key(inv), 1, "s", vm.getBlockTimestamp() + 600);
        bytes memory callData = abi.encodeCall(payLink.payWithAuthorization, (inv, sig, auth));
        assertTrue(_simulate(callData), "eth_call passes");
        assertEq(_paymentValidThrough(inv, auth), inv.validUntil, "the invoice bound is the binding one");
        assertFalse(_admissible(_paymentValidThrough(inv, auth), vm.getBlockTimestamp()), "refused at admission");

        _includeAfter(1);
        (bool ok, bytes memory ret) = _send(callData, MONAD_PAY_FLOOR);
        assertFalse(ok);
        assertEq(keccak256(ret), keccak256(abi.encodeWithSelector(IPayLinkV2.Expired.selector, inv.validUntil)));
    }

    /// @notice Cancel variant, no funds at all: a fresh EOA "payee" signs a throwaway invoice and a cancellation
    ///         with `deadline = now`. `eth_call` passes, inclusion reverts `SignatureExpired`.
    function test_SimulationDoesNotBind_CancelDeadlineNow() public {
        (address throwaway, uint256 throwawayKey) = makeAddrAndKey("throwawayPayee");
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        inv.payee = throwaway;
        uint256 deadline = vm.getBlockTimestamp();
        bytes memory callData =
            abi.encodeCall(payLink.cancelBySig, (inv, deadline, _signCancel(throwawayKey, inv, deadline)));
        assertTrue(_simulate(callData), "eth_call passes");
        assertFalse(_admissible(deadline, vm.getBlockTimestamp()), "refused at admission");

        _includeAfter(1);
        (bool ok, bytes memory ret) = _send(callData, MONAD_CANCEL_FLOOR);
        assertFalse(ok);
        assertEq(keccak256(ret), keccak256(abi.encodeWithSelector(IPayLinkV2.SignatureExpired.selector, deadline)));
        assertEq(throwaway.balance + usdc.balanceOf(throwaway), 0, "the attacker holds nothing");
        console.log(
            "relayer loss on Monad per grief without the margin (wei of MON):", MONAD_CANCEL_FLOOR * MONAD_MIN_BASE_FEE
        );
    }

    // ------------------------------------------------------------------ the margin is exact at the second

    /// @notice A payment admitted with exactly the margin still settles when included `margin` seconds later; one
    ///         second less of validity would revert there. Same for the payer's and the invoice's bound.
    function test_Margin_PaymentAdmittedAtTheEdgeSettlesAfterMarginLatency() public {
        (IPayLinkV2.Invoice memory card, bytes memory sig) = _honestReceiveCard();
        uint256 t = vm.getBlockTimestamp();
        // validThrough = validBefore - 1 = t + margin: admissible, and valid in a block stamped t + margin.
        IPayLinkV2.Authorization memory edge =
            _authorizeUntil(payerKey, _key(card), USDC_25, "edge", t + RELAY_MARGIN + 1);
        IPayLinkV2.Authorization memory short =
            _authorizeUntil(payerKey, _key(card), USDC_25, "short", t + RELAY_MARGIN);
        assertTrue(_admissible(_paymentValidThrough(card, edge), t));
        assertFalse(_admissible(_paymentValidThrough(card, short), t));

        _includeAfter(RELAY_MARGIN);
        (bool shortOk,) = _send(abi.encodeCall(payLink.payWithAuthorization, (card, sig, short)), MONAD_PAY_FLOOR);
        assertFalse(shortOk, "one second less would revert at t + margin");
        (bool edgeOk,) = _send(abi.encodeCall(payLink.payWithAuthorization, (card, sig, edge)), MONAD_PAY_FLOOR);
        assertTrue(edgeOk, "the admitted relay settles after margin seconds of latency");
    }

    function test_Margin_InvoiceAdmittedAtTheEdgeSettlesAfterMarginLatency() public {
        IPayLinkV2.Invoice memory inv = _invoiceN(address(usdc), 0, 0);
        uint256 t = vm.getBlockTimestamp();
        inv.validUntil = uint64(t + RELAY_MARGIN);
        bytes memory sig = _signInvoice(inv);
        IPayLinkV2.Authorization memory auth = _authorizeUntil(payerKey, _key(inv), USDC_25, "s", t + 600);
        assertTrue(_admissible(_paymentValidThrough(inv, auth), t), "validUntil = now + margin is admissible");
        assertFalse(_admissible(_paymentValidThrough(inv, auth), t + 1), "one second later it is not");

        _includeAfter(RELAY_MARGIN);
        (bool ok,) = _send(abi.encodeCall(payLink.payWithAuthorization, (inv, sig, auth)), MONAD_PAY_FLOOR);
        assertTrue(ok, "validUntil is inclusive");
    }

    function test_Margin_CancelAdmittedAtTheEdgeSettlesAfterMarginLatency() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        uint256 deadline = vm.getBlockTimestamp() + RELAY_MARGIN;
        assertTrue(_admissible(deadline, vm.getBlockTimestamp()));
        bytes memory callData =
            abi.encodeCall(payLink.cancelBySig, (inv, deadline, _signCancel(payeeKey, inv, deadline)));
        _includeAfter(RELAY_MARGIN);
        (bool ok,) = _send(callData, MONAD_CANCEL_FLOOR);
        assertTrue(ok, "the deadline is inclusive");
        assertTrue(payLink.stateOf(_key(inv)).cancelled);
    }

    // ------------------------------------------------------------------ attribution evidence

    /// @notice The same authorization landing first by another route (a front-runner copying the relayer's calldata,
    ///         or the payer's own spec §8.6 resubmission) settles the payment once and reverts the relay with
    ///         "authorization is used or canceled". No party misbehaved: the SDK classifies it `superseded` (no ban)
    ///         because, in the settling transaction, the token's `AuthorizationUsed(payer, nonce)` immediately
    ///         follows PayLinkV2's `Paid` for this exact payment. This pins that adjacency.
    function test_SameAuthorizationLandedElsewhere_IsRecognisableFromTheSettlingLogs() public {
        (IPayLinkV2.Invoice memory card, bytes memory sig) = _honestReceiveCard();
        IPayLinkV2.Authorization memory auth =
            _authorizeUntil(payerKey, _key(card), USDC_25, "s", vm.getBlockTimestamp() + 600);
        bytes memory callData = abi.encodeCall(payLink.payWithAuthorization, (card, sig, auth));
        assertTrue(_simulate(callData), "eth_call passes");

        vm.recordLogs();
        vm.prank(stranger); // or the payer itself, resubmitting the same signed authorization
        payLink.payWithAuthorization(card, sig, auth);
        _assertSettledBy(vm.getRecordedLogs(), _key(card), _nonce(_key(card), payer, USDC_25, REF, "s"));

        _includeAfter(1);
        (bool ok, bytes memory ret) = _send(callData, MONAD_PAY_FLOOR);
        assertFalse(ok, "the relay reverts");
        assertEq(
            keccak256(ret),
            keccak256(abi.encodeWithSignature("Error(string)", "FiatTokenV2: authorization is used or canceled"))
        );
        assertEq(usdc.balanceOf(payee), USDC_25, "the payment itself settled once");
        assertEq(payLink.stateOf(_key(card)).payments, 1);
    }

    /// @dev The evidence `attributeRelayRevert` looks for: `AuthorizationUsed(payer, nonce)` from the token, and right
    ///      before it PayLinkV2's `Paid(key, payee, payer, token, amount, ·, payerRef)` for the same payment.
    function _assertSettledBy(Vm.Log[] memory logs, bytes32 key, bytes32 nonce) internal view {
        uint256 used = type(uint256).max;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(usdc) && logs[i].topics[0] == AUTHORIZATION_USED_TOPIC) {
                used = i;
            }
        }
        assertTrue(used > 0 && used < logs.length, "AuthorizationUsed emitted after another log");
        assertEq(logs[used].topics[1], bytes32(uint256(uint160(payer))));
        assertEq(logs[used].topics[2], nonce);
        Vm.Log memory paid = logs[used - 1];
        assertEq(paid.emitter, address(payLink), "the log right before is PayLinkV2's");
        assertEq(paid.topics[0], IPayLinkV2.Paid.selector);
        assertEq(paid.topics[1], key);
        assertEq(paid.topics[2], bytes32(uint256(uint160(payee))));
        assertEq(paid.topics[3], bytes32(uint256(uint160(payer))));
        (address token, uint128 amount,, bytes32 payerRef) = abi.decode(paid.data, (address, uint128, uint32, bytes32));
        assertEq(abi.encode(token, amount, payerRef), abi.encode(address(usdc), USDC_25, REF));
        assertTrue(IERC3009(address(usdc)).authorizationState(payer, nonce));
    }

    /// @notice Contrast: a payer that cancels its authorization on the token (EIP-3009 `cancelAuthorization`) spends
    ///         the same nonce with no `Paid` before it. The relay reverts with the same string, but the evidence
    ///         names the payer (`authorization-spent-elsewhere`), never the payee.
    function test_PayerCancelledAuthorization_LeavesNoPaidBeforeTheNonceLog() public {
        (IPayLinkV2.Invoice memory card, bytes memory sig) = _honestReceiveCard();
        IPayLinkV2.Authorization memory auth =
            _authorizeUntil(payerKey, _key(card), USDC_25, "s", vm.getBlockTimestamp() + 600);
        bytes memory callData = abi.encodeCall(payLink.payWithAuthorization, (card, sig, auth));
        assertTrue(_simulate(callData));

        bytes32 nonce = _nonce(_key(card), payer, USDC_25, REF, "s");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _tokenDomain(address(usdc)),
                keccak256(abi.encode(keccak256("CancelAuthorization(address authorizer,bytes32 nonce)"), payer, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        vm.recordLogs();
        vm.prank(payer);
        IERC3009(address(usdc)).cancelAuthorization(payer, nonce, v, r, s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "AuthorizationCanceled only: no Paid, no AuthorizationUsed");
        assertTrue(IERC3009(address(usdc)).authorizationState(payer, nonce));

        _includeAfter(1);
        (bool ok, bytes memory ret) = _send(callData, MONAD_PAY_FLOOR);
        assertFalse(ok);
        assertEq(
            keccak256(ret),
            keccak256(abi.encodeWithSignature("Error(string)", "FiatTokenV2: authorization is used or canceled"))
        );
        assertEq(usdc.balanceOf(payee), 0);
    }
}
