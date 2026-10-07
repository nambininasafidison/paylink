// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {FeeOnTransfer} from "../mocks/FeeOnTransfer.sol";
import {OverCreditToken} from "../mocks/OverCreditToken.sol";
import {RecipientDebit} from "../mocks/RecipientDebit.sol";
import {TxOriginLure} from "../mocks/TxOriginLure.sol";
import {Wallet1271} from "../mocks/Wallet1271.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice `pay`: allowance settlement, payer -> payee directly, every revert path and every event field.
contract PayTest is BaseTest {
    bytes32 internal constant REF = bytes32("INV-2026-0042");

    IPayLinkV2.Invoice internal inv;
    bytes internal sig;
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        inv = _invoice(address(musd), 25e18);
        sig = _signInvoice(inv);
        key = _key(inv);
        vm.prank(payer);
        musd.approve(address(payLink), type(uint256).max);
    }

    function test_Pay_MovesFundsDirectlyToPayee() public {
        vm.expectEmit(true, true, true, true, address(payLink));
        emit IPayLinkV2.Paid(key, payee, payer, address(musd), 25e18, 0, REF);
        // A single token transfer, payer -> payee: funds never touch PayLink.
        vm.expectEmit(true, true, false, true, address(musd));
        emit IERC20.Transfer(payer, payee, 25e18);

        uint256 payerBefore = musd.balanceOf(payer);
        vm.prank(payer);
        uint32 index = payLink.pay(inv, sig, 25e18, REF);

        assertEq(index, 0);
        assertEq(musd.balanceOf(payee), 25e18);
        assertEq(payerBefore - musd.balanceOf(payer), 25e18);
        assertEq(musd.balanceOf(address(payLink)), 0);
        _assertState(key, 1, false, uint64(vm.getBlockTimestamp()), 25e18);
    }

    function test_Pay_ExactAllowanceIsEnough() public {
        vm.startPrank(payer);
        musd.approve(address(payLink), 25e18);
        payLink.pay(inv, sig, 25e18, REF);
        vm.stopPrank();
        assertEq(musd.allowance(payer, address(payLink)), 0);
    }

    function test_Pay_OpenAmountUnlimitedSeats() public {
        inv = _invoiceN(address(musd), 0, 0);
        sig = _signInvoice(inv);
        key = _key(inv);
        vm.startPrank(payer);
        payLink.pay(inv, sig, 1, REF);
        vm.warp(vm.getBlockTimestamp() + 1);
        payLink.pay(inv, sig, 2e18, REF);
        vm.stopPrank();
        _assertState(key, 2, false, uint64(vm.getBlockTimestamp()), 2e18 + 1);
    }

    function test_Pay_ContractPayer() public {
        Wallet1271 wallet = new Wallet1271(stranger);
        musd.mint(address(wallet), 25e18);
        vm.startPrank(stranger);
        wallet.execute(address(musd), 0, abi.encodeCall(IERC20.approve, (address(payLink), 25e18)));
        wallet.execute(address(payLink), 0, abi.encodeCall(payLink.pay, (inv, sig, 25e18, REF)));
        vm.stopPrank();
        assertEq(musd.balanceOf(payee), 25e18);
    }

    function test_Pay_WorksWith3009TokenToo() public {
        inv.token = address(usdc);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        vm.startPrank(payer);
        usdc.approve(address(payLink), USDC_25);
        payLink.pay(inv, sig, USDC_25, REF);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), USDC_25);
    }

    // ------------------------------------------------------------------ reverts

    function test_RevertWhen_PayeeIsZero() public {
        inv.payee = address(0);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.pay(inv, sig, 25e18, REF);
    }

    function test_RevertWhen_ValidUntilBeforeValidAfter() public {
        inv.validAfter = 10;
        inv.validUntil = 9;
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.pay(inv, sig, 25e18, REF);
    }

    function test_RevertWhen_InvoiceIsNative() public {
        inv.token = address(0);
        sig = _signInvoice(inv);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.WrongPaymentPath.selector);
        payLink.pay(inv, sig, 25e18, REF);
    }

    function test_RevertWhen_Cancelled() public {
        vm.prank(payee);
        payLink.cancel(inv);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.pay(inv, sig, 25e18, REF);
    }

    function test_RevertWhen_SignatureInvalid() public {
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.pay(inv, _sign(strangerKey, key), 25e18, REF);
    }

    function test_RevertWhen_NotYetValid() public {
        inv.validAfter = uint64(vm.getBlockTimestamp() + 1 days);
        sig = _signInvoice(inv);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.NotYetValid.selector, inv.validAfter));
        payLink.pay(inv, sig, 25e18, REF);
    }

    function test_RevertWhen_Expired() public {
        vm.warp(uint256(inv.validUntil) + 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.Expired.selector, inv.validUntil));
        payLink.pay(inv, sig, 25e18, REF);
    }

    function test_RevertWhen_SoldOut() public {
        vm.startPrank(payer);
        payLink.pay(inv, sig, 25e18, REF);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SoldOut.selector, uint32(1)));
        payLink.pay(inv, sig, 25e18, REF);
        vm.stopPrank();
    }

    function test_RevertWhen_WrongAmount() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(25e18), uint128(25e18 + 1)));
        payLink.pay(inv, sig, 25e18 + 1, REF);
    }

    function test_RevertWhen_OpenAmountIsZero() public {
        inv.amount = 0;
        sig = _signInvoice(inv);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(0), uint128(0)));
        payLink.pay(inv, sig, 0, REF);
    }

    function test_RevertWhen_PayerIsPayee() public {
        musd.mint(payee, 25e18);
        vm.startPrank(payee);
        musd.approve(address(payLink), 25e18);
        vm.expectRevert(IPayLinkV2.SelfPayment.selector);
        payLink.pay(inv, sig, 25e18, REF);
        vm.stopPrank();
    }

    function test_RevertWhen_NoAllowance() public {
        vm.prank(payer);
        musd.approve(address(payLink), 0);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(payLink), 0, 25e18)
        );
        payLink.pay(inv, sig, 25e18, REF);
    }

    function test_RevertWhen_InsufficientBalance() public {
        vm.prank(stranger);
        musd.approve(address(payLink), 25e18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, stranger, 0, 25e18));
        payLink.pay(inv, sig, 25e18, REF);
    }

    function test_RevertWhen_FeeOnTransfer() public {
        FeeOnTransfer fot = new FeeOnTransfer(50, FeeOnTransfer.FeeMode.DeductFromAmount); // 0.5%
        fot.mint(payer, 1000e6);
        inv.token = address(fot);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        vm.startPrank(payer);
        fot.approve(address(payLink), USDC_25);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, USDC_25 - 125_000));
        payLink.pay(inv, sig, USDC_25, REF);
        vm.stopPrank();
    }

    /// @notice A token that reports success but credits nothing (100% fee) is caught by the payee-delta check.
    function test_RevertWhen_TokenCreditsNothing() public {
        FeeOnTransfer fot = new FeeOnTransfer(10_000, FeeOnTransfer.FeeMode.DeductFromAmount);
        fot.mint(payer, 1000e6);
        inv.token = address(fot);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        vm.startPrank(payer);
        fot.approve(address(payLink), USDC_25);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, 0));
        payLink.pay(inv, sig, USDC_25, REF);
        vm.stopPrank();
    }

    /// @notice A payee balance that *falls* during the transfer is reported as `PayeeShortPaid(amount, 0)`, the documented
    ///         form (IPayLinkV2), not as an arithmetic panic.
    function test_RevertWhen_PayeeBalanceDecreases() public {
        RecipientDebit rdb = new RecipientDebit();
        rdb.mint(payer, 1000e6);
        rdb.mint(payee, 1000e6); // the transfer debits this balance instead of crediting it
        rdb.setDebited(payee);
        inv.token = address(rdb);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        vm.startPrank(payer);
        rdb.approve(address(payLink), USDC_25);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, 0));
        payLink.pay(inv, sig, USDC_25, REF);
        vm.stopPrank();
    }

    /// @notice I6 is an equality: a payee credited *more* than `amount` is refused as well, with the documented
    ///         `PayeeShortPaid(amount, credited)` from `_pullExact`, here one base unit over. A check weakened to
    ///         `credited < amount` lets this payment settle.
    function test_RevertWhen_PayeeOverCredited() public {
        OverCreditToken oct = new OverCreditToken();
        oct.mint(payer, 1000e6);
        oct.arm(OverCreditToken.Mode.BonusOnPull, address(payLink), 1);
        inv.token = address(oct);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        vm.startPrank(payer);
        oct.approve(address(payLink), USDC_25);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, USDC_25 + 1));
        payLink.pay(inv, sig, USDC_25, REF);
        vm.stopPrank();
        assertEq(oct.balanceOf(payee), 0);
    }

    // ------------------------------------------------------------------ the payer is msg.sender (SWC-115)

    /// @notice The payer is `msg.sender`, never `tx.origin`: with both accounts funded and approving, only the
    ///         direct caller is debited and named in `Paid`.
    function test_Pay_PayerIsMsgSenderNotTxOrigin() public {
        musd.mint(stranger, 100e18);
        vm.prank(stranger);
        musd.approve(address(payLink), type(uint256).max);
        uint256 payerBefore = musd.balanceOf(payer);
        uint256 strangerBefore = musd.balanceOf(stranger);

        vm.expectEmit(true, true, true, true, address(payLink));
        emit IPayLinkV2.Paid(key, payee, stranger, address(musd), 25e18, 0, REF);
        vm.prank(stranger, payer); // msg.sender = stranger, tx.origin = payer
        payLink.pay(inv, sig, 25e18, REF);

        assertEq(strangerBefore - musd.balanceOf(stranger), 25e18, "msg.sender debited");
        assertEq(musd.balanceOf(payer), payerBefore, "tx.origin untouched");
    }

    /// @notice SWC-115 phishing: a payer who granted PayLink a standing allowance is lured into calling an attacker's
    ///         contract, which calls `pay` on an invoice of the attacker's choosing. The lure is the payer
    ///         (`msg.sender`) and has no allowance, so the victim's allowance cannot be spent.
    function test_RevertWhen_LuredPayerAllowanceWouldBeSpent() public {
        TxOriginLure lure = new TxOriginLure(address(payLink), abi.encodeCall(payLink.pay, (inv, sig, 25e18, REF)));
        uint256 payerBefore = musd.balanceOf(payer);
        vm.prank(payer, payer); // the victim's own transaction
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(payLink), 0, 25e18)
        );
        lure.claim();
        assertEq(musd.balanceOf(payer), payerBefore, "victim not debited");
        assertEq(musd.allowance(payer, address(payLink)), type(uint256).max, "victim allowance intact");
    }

    /// @notice `SelfPayment` compares the payee with `msg.sender`: the payee calling directly is refused whatever the
    ///         transaction origin, and the payee as mere origin of a payment made by another account is not refused.
    function test_SelfPaymentIgnoresTxOrigin() public {
        musd.mint(payee, 25e18);
        vm.prank(payee);
        musd.approve(address(payLink), 25e18);
        vm.prank(payee, payer);
        vm.expectRevert(IPayLinkV2.SelfPayment.selector);
        payLink.pay(inv, sig, 25e18, REF);

        vm.prank(payer, payee);
        payLink.pay(inv, sig, 25e18, REF);
        _assertState(key, 1, false, uint64(vm.getBlockTimestamp()), 25e18);
    }

    function test_RevertWhen_TokenHasNoCode() public {
        inv.token = makeAddr("eoa-token");
        sig = _signInvoice(inv);
        vm.prank(payer);
        vm.expectRevert(bytes(""));
        payLink.pay(inv, sig, 25e18, REF);
    }
}
