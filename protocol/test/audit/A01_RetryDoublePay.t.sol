// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @title AUDIT-01 regression: retries must not create a second payment (invoice spec §8.6)
/// @notice Finding A-01 (medium): the invoice spec (§8.2, before the fix) told clients to re-sign every attempt with
///         a fresh `payerSalt`, and the SDK router offered permit and approve-and-pay after a slow relay. A retry is
///         usually caused by a relayer that is slow, not one whose transaction failed, so the first authorization is
///         still live (`validBefore` = now + 600 s by default). On a link with `maxPayments != 1` (receive card,
///         open-amount till, N seats) both settled and the payer was charged twice; the relayer decided whether.
///         Status: fixed in the client, by design of the contract. Invoice spec §8.6 now makes a retry resubmit the
///         same signed authorization and allows a new salt or another path only once the old authorization is dead;
///         `packages/sdk/src/attempts.ts`, `authorizePayment` and the router enforce it, and the SDK's anvil suite
///         replays the slow-relayer scenarios end to end. PayLinkV2 keeps no cross-authorization state on purpose
///         (a receive card must accept many payments from one payer); these tests pin the on-chain facts the client
///         rule rests on:
///         - `test_NoDedupe_*`: two authorizations with different salts, or an authorization plus a permit payment,
///           are two payments wherever `maxPayments != 1`;
///         - `test_Control_OneOffInvoiceIsSafe`: a one-off invoice cannot be charged twice (`SoldOut`);
///         - `test_Fix_*`: the same authorization settles at most once, and `cancelAuthorization` or expiry kills a
///           stale one, so a client following §8.6 charges once.
/// @dev Run: forge test --match-path 'test/audit/A01_RetryDoublePay.t.sol' -vv
contract A01RetryDoublePayTest is BaseTest {
    bytes32 internal constant REF = bytes32("TILL-ORDER-7");
    /// @dev `DEFAULT_AUTHORIZATION_TTL_SECONDS` in packages/sdk/src/constants.ts.
    uint256 internal constant SDK_TTL = 600;
    bytes32 internal constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @dev The authorization the SDK's `authorizePayment` builds: validAfter 0, validBefore now + 600 s.
    function _sdkAuth(bytes32 key, uint128 amount, bytes32 payerSalt)
        internal
        view
        returns (IPayLinkV2.Authorization memory auth)
    {
        auth.payer = payer;
        auth.amount = amount;
        auth.payerRef = REF;
        auth.payerSalt = payerSalt;
        auth.validAfter = 0;
        auth.validBefore = vm.getBlockTimestamp() + SDK_TTL;
        _signAuthorization(payerKey, address(usdc), auth, _nonce(key, payer, amount, REF, payerSalt));
    }

    function _card(uint128 amount, uint32 maxPayments)
        internal
        returns (IPayLinkV2.Invoice memory card, bytes memory sig, bytes32 key)
    {
        card = _invoiceN(address(usdc), amount, maxPayments);
        card.validUntil = 0; // receive card: no expiry
        sig = _signInvoice(card);
        key = _key(card);
    }

    // ------------------------------------------------------------------ what the contract does not prevent

    /// @notice A retry that re-signs (fresh salt, self-submitted) plus a late relayer landing are two charges. This is
    ///         what invoice spec §8.6 forbids clients to do.
    function test_NoDedupe_FreshSaltRetryChargesReceiveCardTwice() public {
        (IPayLinkV2.Invoice memory card, bytes memory sig, bytes32 key) = _card(USDC_25, 0);
        uint256 payerStart = usdc.balanceOf(payer);

        // Attempt 1 goes to the relayer (POST /v1/{chainId}/pay), which accepts it but does not land it yet.
        IPayLinkV2.Authorization memory attempt1 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-1"));
        bytes32 nonce1 = _nonce(key, payer, USDC_25, REF, bytes32("salt-attempt-1"));

        // 30 s later the client gives up and retries "with your own gas", re-signing with a fresh salt (§8.2).
        skip(30);
        IPayLinkV2.Authorization memory attempt2 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-2"));
        vm.prank(payer);
        payLink.payWithAuthorization(card, sig, attempt2);
        assertFalse(usdc.authorizationState(payer, nonce1), "attempt 1 is still live after the retry settled");

        // Within validBefore the relayer (or anyone who saw attempt 1) lands it.
        skip(120);
        vm.prank(relayer);
        payLink.payWithAuthorization(card, sig, attempt1);

        assertEq(payerStart - usdc.balanceOf(payer), 2 * uint256(USDC_25), "payer charged twice for one purchase");
        assertEq(usdc.balanceOf(payee), 2 * uint256(USDC_25), "payee received both");
        _assertState(key, 2, false, uint64(vm.getBlockTimestamp()), 2 * USDC_25);
    }

    /// @notice Same with a `permit` fallback while the relayed authorization is live: two charges. The router now
    ///         withholds permit and approve-and-pay until the authorization is cancelled or expired.
    function test_NoDedupe_PermitFallbackChargesReceiveCardTwice() public {
        (IPayLinkV2.Invoice memory card, bytes memory sig, bytes32 key) = _card(USDC_25, 0);
        uint256 payerStart = usdc.balanceOf(payer);

        IPayLinkV2.Authorization memory attempt1 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-1"));

        skip(30);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(usdc), USDC_25, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        payLink.payWithPermit(card, sig, USDC_25, REF, p);

        skip(120);
        vm.prank(relayer);
        payLink.payWithAuthorization(card, sig, attempt1);

        assertEq(payerStart - usdc.balanceOf(payer), 2 * uint256(USDC_25), "payer charged twice for one purchase");
        _assertState(key, 2, false, uint64(vm.getBlockTimestamp()), 2 * USDC_25);
    }

    /// @notice Open-amount till (spec §13.4): the payer types 12.34, gets charged 24.68.
    function test_NoDedupe_OpenAmountTillChargesTwice() public {
        (IPayLinkV2.Invoice memory till, bytes memory sig, bytes32 key) = _card(0, 0);
        uint128 typed = 12_340_000;
        uint256 payerStart = usdc.balanceOf(payer);

        IPayLinkV2.Authorization memory attempt1 = _sdkAuth(key, typed, bytes32("salt-attempt-1"));
        skip(30);
        IPayLinkV2.Authorization memory attempt2 = _sdkAuth(key, typed, bytes32("salt-attempt-2"));
        vm.prank(payer);
        payLink.payWithAuthorization(till, sig, attempt2);
        vm.prank(relayer);
        payLink.payWithAuthorization(till, sig, attempt1);

        assertEq(payerStart - usdc.balanceOf(payer), 2 * uint256(typed), "payer charged twice");
    }

    /// @notice Ticket link with 3 seats: the payer wanted one seat and holds two.
    function test_NoDedupe_MultiSeatLinkSellsTwoSeats() public {
        (IPayLinkV2.Invoice memory tickets, bytes memory sig, bytes32 key) = _card(USDC_25, 3);

        IPayLinkV2.Authorization memory attempt1 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-1"));
        skip(30);
        IPayLinkV2.Authorization memory attempt2 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-2"));
        vm.prank(payer);
        payLink.payWithAuthorization(tickets, sig, attempt2);
        vm.prank(relayer);
        payLink.payWithAuthorization(tickets, sig, attempt1);

        assertEq(payLink.stateOf(key).payments, 2, "two seats sold to one buyer");
    }

    // ------------------------------------------------------------------ controls, and the facts the fix relies on

    /// @notice Control: a one-off invoice cannot be charged twice (the stale attempt reverts `SoldOut`).
    function test_Control_OneOffInvoiceIsSafe() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) = _card(USDC_25, 1);
        IPayLinkV2.Authorization memory attempt1 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-1"));
        IPayLinkV2.Authorization memory attempt2 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-2"));
        vm.prank(payer);
        payLink.payWithAuthorization(inv, sig, attempt2);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SoldOut.selector, uint32(1)));
        payLink.payWithAuthorization(inv, sig, attempt1);
    }

    /// @notice Fix, rule 2: retry by resubmitting the *same* authorization. A reverted relay does not consume the
    ///         token nonce, so the same signature can always be retried; whichever copy lands first wins.
    function test_Fix_ResubmitSameAuthorizationIsIdempotent() public {
        (IPayLinkV2.Invoice memory card, bytes memory sig, bytes32 key) = _card(USDC_25, 0);
        IPayLinkV2.Authorization memory attempt1 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-1"));
        vm.prank(payer);
        payLink.payWithAuthorization(card, sig, attempt1); // self-submitted retry of the same signature
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        payLink.payWithAuthorization(card, sig, attempt1);
        assertEq(usdc.balanceOf(payee), USDC_25, "charged once");
    }

    /// @notice Fix, rule 3: before a *different* path or salt, revoke attempt 1 with the token's
    ///         `cancelAuthorization` (or wait until `validBefore`; see the next test).
    function test_Fix_CancelAuthorizationBeforeFallback() public {
        (IPayLinkV2.Invoice memory card, bytes memory sig, bytes32 key) = _card(USDC_25, 0);
        IPayLinkV2.Authorization memory attempt1 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-1"));
        bytes32 nonce1 = _nonce(key, payer, USDC_25, REF, bytes32("salt-attempt-1"));

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _tokenDomain(address(usdc)),
                keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, payer, nonce1))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        vm.prank(payer);
        usdc.cancelAuthorization(payer, nonce1, v, r, s);

        IPayLinkV2.Permit memory p = _permit(payerKey, address(usdc), USDC_25, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        payLink.payWithPermit(card, sig, USDC_25, REF, p);

        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        payLink.payWithAuthorization(card, sig, attempt1);
        assertEq(usdc.balanceOf(payee), USDC_25, "charged once");
    }

    /// @notice Fix, rule 3 (expiry): once chain time reaches `validBefore` with `authorizationState` still false, the
    ///         stale authorization can never land, so a new signature or another path is safe.
    function test_Fix_ExpiredAuthorizationNeverLands() public {
        (IPayLinkV2.Invoice memory card, bytes memory sig, bytes32 key) = _card(USDC_25, 0);
        IPayLinkV2.Authorization memory attempt1 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-1"));
        bytes32 nonce1 = _nonce(key, payer, USDC_25, REF, bytes32("salt-attempt-1"));

        vm.warp(attempt1.validBefore); // FiatToken requires now < validBefore
        assertFalse(usdc.authorizationState(payer, nonce1), "never used: dead, not consumed");
        IPayLinkV2.Authorization memory attempt2 = _sdkAuth(key, USDC_25, bytes32("salt-attempt-2"));
        vm.prank(payer);
        payLink.payWithAuthorization(card, sig, attempt2);

        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        payLink.payWithAuthorization(card, sig, attempt1);
        assertEq(usdc.balanceOf(payee), USDC_25, "charged once");
    }
}
