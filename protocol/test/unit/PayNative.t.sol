// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {PeekingPayee} from "../mocks/PeekingPayee.sol";
import {RevertingPayee} from "../mocks/RevertingPayee.sol";
import {Wallet1271} from "../mocks/Wallet1271.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice `payNative`: native coin forwarded within the call, every revert path and every event field.
contract PayNativeTest is BaseTest {
    bytes32 internal constant REF = bytes32("TABLE-4");

    IPayLinkV2.Invoice internal inv;
    bytes internal sig;
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        inv = _invoice(address(0), 25 ether);
        sig = _signInvoice(inv);
        key = _key(inv);
    }

    function test_PayNative_ForwardsValueToPayee() public {
        vm.expectEmit(true, true, true, true, address(payLink));
        emit IPayLinkV2.Paid(key, payee, payer, address(0), 25 ether, 0, REF);

        uint256 payerBefore = payer.balance;
        vm.prank(payer);
        uint32 index = payLink.payNative{value: 25 ether}(inv, sig, REF);

        assertEq(index, 0);
        assertEq(payee.balance, 25 ether);
        assertEq(payerBefore - payer.balance, 25 ether);
        assertEq(address(payLink).balance, 0);
        _assertState(key, 1, false, uint64(vm.getBlockTimestamp()), 25 ether);
    }

    /// @notice Checks-effects-interactions on the native path (spec §3.3.3; re-audit finding, mutant M46): the payee's
    ///         `receive` is untrusted code that runs mid-call, and a read-only re-entry from it must already see the
    ///         payment recorded. `nonReentrant` does not cover views, so only the order of effects does.
    function test_PayNative_ReadOnlyReentrySeesPostEffectsState() public {
        PeekingPayee peek = new PeekingPayee(payLink, payee);
        inv = _invoiceN(address(0), 0, 0);
        inv.payee = address(peek);
        key = _key(inv);
        sig = _sign(payeeKey, key);
        peek.watch(key);

        vm.prank(payer);
        payLink.payNative{value: 1 ether}(inv, sig, REF);
        (uint32 payments, bool cancelled, uint64 lastPaidAt, uint128 total) = peek.seen();
        assertEq(peek.peeks(), 1, "the payee's receive ran");
        assertEq(payments, 1, "payments already recorded when the coin arrives");
        assertEq(total, 1 ether, "total already recorded");
        assertEq(lastPaidAt, vm.getBlockTimestamp(), "lastPaidAt already recorded");
        assertFalse(cancelled);

        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(payer);
        payLink.payNative{value: 2 ether}(inv, sig, REF);
        (payments,, lastPaidAt, total) = peek.seen();
        assertEq(
            abi.encode(payments, lastPaidAt, total),
            abi.encode(uint32(2), uint64(vm.getBlockTimestamp()), uint128(3 ether))
        );
        _assertState(key, 2, false, uint64(vm.getBlockTimestamp()), 3 ether);
    }

    /// @notice The payer is `msg.sender`, never `tx.origin` (SWC-115): `Paid` names the caller, and the payee as mere
    ///         origin of the transaction is no `SelfPayment`.
    function test_PayNative_PayerIsMsgSenderNotTxOrigin() public {
        vm.deal(stranger, 25 ether);
        vm.expectEmit(true, true, true, true, address(payLink));
        emit IPayLinkV2.Paid(key, payee, stranger, address(0), 25 ether, 0, REF);
        vm.prank(stranger, payee); // msg.sender = stranger, tx.origin = the payee
        payLink.payNative{value: 25 ether}(inv, sig, REF);
        assertEq(payee.balance, 25 ether);
    }

    /// @notice The payee calling directly is a `SelfPayment` whatever the transaction origin.
    function test_RevertWhen_PayeePaysWithAnotherTxOrigin() public {
        vm.deal(payee, 25 ether);
        vm.prank(payee, payer);
        vm.expectRevert(IPayLinkV2.SelfPayment.selector);
        payLink.payNative{value: 25 ether}(inv, sig, REF);
    }

    function test_PayNative_OpenAmount() public {
        inv = _invoiceN(address(0), 0, 0);
        sig = _signInvoice(inv);
        key = _key(inv);
        vm.startPrank(payer);
        payLink.payNative{value: 1 wei}(inv, sig, REF);
        payLink.payNative{value: 3 ether}(inv, sig, REF);
        vm.stopPrank();
        _assertState(key, 2, false, uint64(vm.getBlockTimestamp()), 3 ether + 1);
        assertEq(payee.balance, 3 ether + 1);
    }

    function test_PayNative_To1271Wallet() public {
        Wallet1271 wallet = new Wallet1271(payee);
        inv.payee = address(wallet);
        key = _key(inv);
        sig = _sign(payeeKey, key);
        vm.prank(payer);
        payLink.payNative{value: 25 ether}(inv, sig, REF);
        assertEq(address(wallet).balance, 25 ether);
    }

    function test_PayNative_DonatedBalanceIsUntouched() public {
        vm.deal(address(payLink), 1 ether); // forced: SELFDESTRUCT or coinbase
        vm.prank(payer);
        payLink.payNative{value: 25 ether}(inv, sig, REF);
        assertEq(address(payLink).balance, 1 ether);
        assertEq(payee.balance, 25 ether);
    }

    // ------------------------------------------------------------------ reverts

    function test_RevertWhen_InvoiceIsErc20() public {
        inv.token = address(usdc);
        sig = _signInvoice(inv);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.WrongPaymentPath.selector);
        payLink.payNative{value: 25 ether}(inv, sig, REF);
    }

    function test_RevertWhen_PayeeIsPayLink() public {
        inv.payee = address(payLink);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.payNative{value: 25 ether}(inv, sig, REF);
    }

    function test_RevertWhen_Cancelled() public {
        vm.prank(payee);
        payLink.cancel(inv);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.payNative{value: 25 ether}(inv, sig, REF);
    }

    function test_RevertWhen_SignatureInvalid() public {
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payNative{value: 25 ether}(inv, _sign(payerKey, key), REF);
    }

    function test_RevertWhen_NotYetValid() public {
        inv.validAfter = uint64(vm.getBlockTimestamp() + 1);
        inv.validUntil = 0;
        sig = _signInvoice(inv);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.NotYetValid.selector, inv.validAfter));
        payLink.payNative{value: 25 ether}(inv, sig, REF);
    }

    function test_RevertWhen_Expired() public {
        vm.warp(uint256(inv.validUntil) + 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.Expired.selector, inv.validUntil));
        payLink.payNative{value: 25 ether}(inv, sig, REF);
    }

    function test_RevertWhen_SoldOut() public {
        vm.startPrank(payer);
        payLink.payNative{value: 25 ether}(inv, sig, REF);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SoldOut.selector, uint32(1)));
        payLink.payNative{value: 25 ether}(inv, sig, REF);
        vm.stopPrank();
    }

    function test_RevertWhen_ValueDiffers() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(25 ether), uint128(24 ether)));
        payLink.payNative{value: 24 ether}(inv, sig, REF);
    }

    function test_RevertWhen_OpenAmountWithoutValue() public {
        inv.amount = 0;
        sig = _signInvoice(inv);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(0), uint128(0)));
        payLink.payNative(inv, sig, REF);
    }

    function test_RevertWhen_ValueExceedsUint128() public {
        inv.amount = 0;
        sig = _signInvoice(inv);
        uint256 value = uint256(type(uint128).max) + 1;
        vm.deal(payer, value);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(0), type(uint128).max));
        payLink.payNative{value: value}(inv, sig, REF);
    }

    function test_RevertWhen_PayerIsPayee() public {
        vm.deal(payee, 25 ether);
        vm.prank(payee);
        vm.expectRevert(IPayLinkV2.SelfPayment.selector);
        payLink.payNative{value: 25 ether}(inv, sig, REF);
    }

    function test_RevertWhen_PayeeRejectsWithError() public {
        RevertingPayee bad = new RevertingPayee(RevertingPayee.Mode.RevertWithError);
        inv.payee = address(bad);
        vm.prank(payer);
        vm.expectRevert(RevertingPayee.PayeeRejected.selector);
        payLink.payNative{value: 25 ether}(inv, "", REF);
    }

    function test_RevertWhen_PayeeRejectsSilently() public {
        RevertingPayee bad = new RevertingPayee(RevertingPayee.Mode.RevertEmpty);
        inv.payee = address(bad);
        vm.prank(payer);
        vm.expectRevert(Errors.FailedCall.selector);
        payLink.payNative{value: 25 ether}(inv, "", REF);
    }

    function test_RevertWhen_PayeeReentersPayNative() public {
        RevertingPayee bad = new RevertingPayee(RevertingPayee.Mode.RevertEmpty);
        inv.payee = address(bad);
        inv.amount = 0;
        inv.maxPayments = 0;
        bad.setReentry(address(payLink), abi.encodeCall(payLink.payNative, (inv, "", REF)));
        vm.prank(payer);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        payLink.payNative{value: 1 ether}(inv, "", REF);
    }

    function test_RevertWhen_PayeeReentersCancel() public {
        RevertingPayee bad = new RevertingPayee(RevertingPayee.Mode.RevertEmpty);
        inv.payee = address(bad);
        bad.setReentry(address(payLink), abi.encodeCall(payLink.cancel, (inv)));
        vm.prank(payer);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        payLink.payNative{value: 25 ether}(inv, "", REF);
    }
}
