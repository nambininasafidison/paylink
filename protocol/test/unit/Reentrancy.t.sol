// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {HookReentrant} from "../mocks/HookReentrant.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Every state-changing entry point is `nonReentrant`; a token callback cannot re-enter any of them, and a
///         read-only re-entry observes the post-effects state.
contract ReentrancyTest is BaseTest {
    bytes32 internal constant REF = bytes32("RE");

    HookReentrant internal hook;
    IPayLinkV2.Invoice internal inv;
    bytes internal sig;
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        hook = new HookReentrant();
        hook.mint(payer, 1000e6);
        inv = _invoiceN(address(hook), USDC_25, 0);
        sig = _signInvoice(inv);
        key = _key(inv);
        vm.prank(payer);
        hook.approve(address(payLink), type(uint256).max);
    }

    function _reentryCalls() internal returns (bytes[6] memory calls) {
        IPayLinkV2.Invoice memory other = _invoice(address(hook), USDC_25);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(hook), _key(other), USDC_25, REF, "x");
        IPayLinkV2.Permit memory p;
        calls = [
            abi.encodeCall(payLink.payWithAuthorization, (other, "", auth)),
            abi.encodeCall(payLink.pay, (other, "", USDC_25, REF)),
            abi.encodeCall(payLink.payWithPermit, (other, "", USDC_25, REF, p)),
            abi.encodeCall(payLink.payNative, (other, "", REF)),
            abi.encodeCall(payLink.cancel, (other)),
            abi.encodeCall(payLink.cancelBySig, (other, type(uint256).max, ""))
        ];
    }

    function test_RevertWhen_TokenHookReentersDuringPay() public {
        bytes[6] memory calls = _reentryCalls();
        for (uint256 i = 0; i < calls.length; ++i) {
            hook.arm(HookReentrant.Trigger.OnTransfer, address(payLink), calls[i], true);
            vm.prank(payer);
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            payLink.pay(inv, sig, USDC_25, REF);
        }
    }

    function test_RevertWhen_TokenHookReentersDuringPayWithAuthorization() public {
        bytes[6] memory calls = _reentryCalls();
        for (uint256 i = 0; i < calls.length; ++i) {
            IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(hook), key, USDC_25, REF, bytes32(i));
            hook.arm(HookReentrant.Trigger.OnTransfer, address(payLink), calls[i], true);
            vm.prank(relayer);
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            payLink.payWithAuthorization(inv, sig, auth);
        }
    }

    /// @notice A re-entry from inside `permit` is refused by the guard. Whether the token then bubbles the refusal
    ///         (the permit fails inside try/catch and the existing allowance is used) or swallows it, the payment
    ///         settles exactly once.
    function test_TokenHookReentryDuringPermitIsRefused() public {
        bytes[6] memory calls = _reentryCalls();
        for (uint256 i = 0; i < calls.length; ++i) {
            // Bubbling: the hook's records roll back with the failed permit, so only the outcome is observable.
            vm.prank(payer);
            hook.approve(address(payLink), USDC_25); // the pre-existing allowance the failed permit falls back to
            IPayLinkV2.Permit memory p = _permit(payerKey, address(hook), USDC_25, vm.getBlockTimestamp() + 1 hours);
            hook.arm(HookReentrant.Trigger.OnPermit, address(payLink), calls[i], true);
            vm.prank(payer);
            payLink.payWithPermit(inv, sig, USDC_25, REF, p);

            // Swallowing: the hook records the guard's refusal.
            p = _permit(payerKey, address(hook), USDC_25, vm.getBlockTimestamp() + 1 hours);
            hook.arm(HookReentrant.Trigger.OnPermit, address(payLink), calls[i], false);
            vm.prank(payer);
            payLink.payWithPermit(inv, sig, USDC_25, REF, p);
            assertTrue(hook.hookCalled());
            assertFalse(hook.lastHookOk());
            assertEq(
                hook.lastHookReturn(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
            );
        }
        _assertState(key, 12, false, uint64(vm.getBlockTimestamp()), 12 * USDC_25);
        assertEq(hook.balanceOf(payee), 12 * USDC_25);
    }

    /// @notice If the hook swallows the guard's revert, the outer payment completes exactly once.
    function test_SwallowedReentryDoesNotDoubleSpend() public {
        hook.arm(
            HookReentrant.Trigger.OnTransfer,
            address(payLink),
            abi.encodeCall(payLink.pay, (inv, sig, USDC_25, REF)),
            false
        );
        vm.prank(payer);
        payLink.pay(inv, sig, USDC_25, REF);
        assertTrue(hook.hookCalled());
        assertFalse(hook.lastHookOk());
        assertEq(hook.lastHookReturn(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(hook.balanceOf(payee), USDC_25);
        _assertState(key, 1, false, uint64(vm.getBlockTimestamp()), USDC_25);
    }

    /// @notice Read-only re-entry during the transfer sees the payment already recorded (checks-effects-interactions).
    ///         `pay` path; `payWithAuthorization` below, `payWithPermit` in PayWithPermit.t.sol and `payNative` in
    ///         PayNative.t.sol, so that every settlement path is pinned (mutants M46-M49).
    function test_ReadOnlyReentrySeesPostEffectsState() public {
        hook.arm(HookReentrant.Trigger.OnTransfer, address(payLink), abi.encodeCall(payLink.stateOf, (key)), true);
        vm.prank(payer);
        payLink.pay(inv, sig, USDC_25, REF);
        IPayLinkV2.LinkState memory seen = abi.decode(hook.lastHookReturn(), (IPayLinkV2.LinkState));
        assertEq(seen.payments, 1);
        assertEq(seen.total, USDC_25);
        assertEq(seen.lastPaidAt, vm.getBlockTimestamp());
    }

    /// @notice The same on the EIP-3009 path (re-audit finding, mutant M47): the token runs the hook while it moves
    ///         the funds in `receiveWithAuthorization`, and the forward to the payee, after `Paid`; a read of
    ///         `stateOf` from it must see the post-payment state, and on a second payment the incremented one.
    function test_ReadOnlyReentrySeesPostEffectsState_PayWithAuthorization() public {
        for (uint256 i = 1; i <= 2; ++i) {
            vm.warp(vm.getBlockTimestamp() + 1);
            IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(hook), key, USDC_25, REF, bytes32(i));
            hook.arm(HookReentrant.Trigger.OnTransfer, address(payLink), abi.encodeCall(payLink.stateOf, (key)), true);
            vm.prank(relayer);
            payLink.payWithAuthorization(inv, sig, auth);
            assertTrue(hook.hookCalled() && hook.lastHookOk(), "hook ran");
            IPayLinkV2.LinkState memory seen = abi.decode(hook.lastHookReturn(), (IPayLinkV2.LinkState));
            assertEq(seen.payments, i, "payments already recorded during the token call");
            assertEq(seen.total, i * USDC_25, "total already recorded");
            assertEq(seen.lastPaidAt, vm.getBlockTimestamp(), "lastPaidAt already recorded");
        }
    }
}
