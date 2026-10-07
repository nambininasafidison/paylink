// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {OverCreditToken} from "../mocks/OverCreditToken.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @title A-05: exactness in the over-credit direction (invariant I6, spec §3.3.3 step 5)
/// @notice The 2026-10-07 re-audit reported that the four exactness checks of PayLinkV2 can each be weakened from
///         `!=` to `<` (accepting a delta *above* the paid amount) without any test failing (mutants R14–R17),
///         and left it open. This audit re-ran those four mutants on this tree with
///         `audit/mutation/run.py`'s `run_one` in `full` mode: all four SURVIVED (262 passed, 0 failed each).
///         No mock in the suite ever over-credits: FeeOnTransfer, Rebasing and RecipientDebit only short-credit.
///         The contract is correct today; the gap is that a refactor turning `!=` into `<` would ship green.
///
///         Each test below drives exactly one check with an `OverCreditToken` mode and pins the exact error and
///         arguments, so each of the four mutants fails at least one test here:
///         - receive check (`received != auth.amount`)           -> `test_RevertWhen_PayLinkReceivesMoreThanAuthorized`
///         - `_pullExact` (`credited != amount`)                  -> `test_RevertWhen_PayeeOverCredited_Pay`, `..._PayWithPermit`
///         - `_pushExact` (`credited != amount`)                  -> `test_RevertWhen_PayeeOverCredited_Forward`
///         - conservation (`balanceAfter != balanceBefore`)       -> `test_RevertWhen_PayLinkEndsAboveItsStartingBalance`
/// @dev Run: forge test --match-path 'test/audit/A05_OverCreditExactness.t.sol' -vv
contract A05OverCreditExactnessTest is BaseTest {
    bytes32 internal constant REF = bytes32("A05");
    uint128 internal constant AMOUNT = 25e6;
    uint256 internal constant BONUS = 7;

    OverCreditToken internal oc;

    function setUp() public override {
        super.setUp();
        oc = new OverCreditToken();
        oc.mint(payer, 1_000_000e6);
        vm.label(address(oc), "OverCreditToken");
    }

    function _signed(uint128 amount) internal returns (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) {
        inv = _invoice(address(oc), amount);
        sig = _signInvoice(inv);
        key = _key(inv);
    }

    // ------------------------------------------------------------------ control

    /// @notice Control: with no mode armed the token is standard and every path settles exactly.
    function test_Control_StandardBehaviourSettles() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) = _signed(AMOUNT);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(oc), key, AMOUNT, REF, bytes32("s1"));
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(oc.balanceOf(payee), AMOUNT);
        assertEq(oc.balanceOf(address(payLink)), 0);
    }

    // ------------------------------------------------------------------ one test per exactness check

    /// @notice Receive check: PayLink is credited `amount + bonus`. Must revert `ReceivedMismatch(amount, amount +
    ///         bonus)` at the receive check itself, not later at the conservation check (which would report
    ///         `ReceivedMismatch(balanceBefore, balanceBefore + bonus)`).
    function test_RevertWhen_PayLinkReceivesMoreThanAuthorized() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) = _signed(AMOUNT);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(oc), key, AMOUNT, REF, bytes32("s1"));
        oc.mint(address(payLink), 1000); // a stray donation, so the two possible errors differ in their arguments
        oc.arm(OverCreditToken.Mode.BonusOnReceive, address(payLink), BONUS);

        vm.expectRevert(
            abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, uint256(AMOUNT), uint256(AMOUNT) + BONUS)
        );
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    /// @notice `_pullExact` on `pay`: the payee is credited `amount + bonus`.
    function test_RevertWhen_PayeeOverCredited_Pay() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig,) = _signed(AMOUNT);
        oc.arm(OverCreditToken.Mode.BonusOnPull, address(payLink), BONUS);
        vm.startPrank(payer);
        oc.approve(address(payLink), AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, uint256(AMOUNT), uint256(AMOUNT) + BONUS)
        );
        payLink.pay(inv, sig, AMOUNT, REF);
        vm.stopPrank();
    }

    /// @notice `_pullExact` on `payWithPermit`.
    function test_RevertWhen_PayeeOverCredited_PayWithPermit() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig,) = _signed(AMOUNT);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(oc), AMOUNT, vm.getBlockTimestamp() + 1 hours);
        oc.arm(OverCreditToken.Mode.BonusOnPull, address(payLink), BONUS);
        vm.expectRevert(
            abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, uint256(AMOUNT), uint256(AMOUNT) + BONUS)
        );
        vm.prank(payer);
        payLink.payWithPermit(inv, sig, AMOUNT, REF, p);
    }

    /// @notice `_pushExact` on the EIP-3009 forward leg: the payee is credited `amount + bonus` while PayLink is
    ///         debited exactly `amount`, so the conservation check alone would pass.
    function test_RevertWhen_PayeeOverCredited_Forward() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) = _signed(AMOUNT);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(oc), key, AMOUNT, REF, bytes32("s1"));
        oc.arm(OverCreditToken.Mode.BonusOnPush, address(payLink), BONUS);
        vm.expectRevert(
            abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, uint256(AMOUNT), uint256(AMOUNT) + BONUS)
        );
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    /// @notice Conservation post-check: receive and payee credit are both exact, but the forward debits PayLink
    ///         only `amount - bonus`, so PayLink ends `bonus` above its starting balance.
    function test_RevertWhen_PayLinkEndsAboveItsStartingBalance() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) = _signed(AMOUNT);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(oc), key, AMOUNT, REF, bytes32("s1"));
        uint256 donation = 1000;
        oc.mint(address(payLink), donation);
        oc.arm(OverCreditToken.Mode.UnderDebitOnPush, address(payLink), BONUS);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, donation, donation + BONUS));
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, auth);
    }
}
