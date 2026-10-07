// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {TxOriginLure} from "../mocks/TxOriginLure.sol";
import {Wallet1271} from "../mocks/Wallet1271.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice `cancel` and `cancelBySig`: only the payee revokes (I9), by `msg.sender` or by its signature and never by
///         `tx.origin` (SWC-115); revocation is permanent (I4, I11).
contract CancelTest is BaseTest {
    IPayLinkV2.Invoice internal inv;
    bytes internal sig;
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        inv = _invoiceN(address(usdc), USDC_25, 3);
        sig = _signInvoice(inv);
        key = _key(inv);
    }

    // ------------------------------------------------------------------ cancel

    function test_Cancel_ByPayee() public {
        vm.expectEmit(true, true, false, true, address(payLink));
        emit IPayLinkV2.InvoiceCancelled(key, payee);
        vm.prank(payee);
        payLink.cancel(inv);
        _assertState(key, 0, true, 0, 0);
    }

    function test_Cancel_KeepsPaymentHistory() public {
        vm.prank(payer);
        usdc.approve(address(payLink), USDC_25);
        vm.prank(payer);
        payLink.pay(inv, sig, USDC_25, "r");
        uint64 paidAt = uint64(vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + 1 hours);

        vm.prank(payee);
        payLink.cancel(inv);
        _assertState(key, 1, true, paidAt, USDC_25);
    }

    function test_Cancel_BlocksEveryPaymentPath() public {
        vm.prank(payee);
        payLink.cancel(inv);

        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, USDC_25, "r", "s");
        IPayLinkV2.Permit memory p = _permit(payerKey, address(usdc), USDC_25, vm.getBlockTimestamp() + 1 hours);
        vm.startPrank(payer);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.payWithAuthorization(inv, sig, auth);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.pay(inv, sig, USDC_25, "r");
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.payWithPermit(inv, sig, USDC_25, "r", p);
        vm.stopPrank();

        IPayLinkV2.Invoice memory native = _invoice(address(0), 1 ether);
        bytes memory nativeSig = _signInvoice(native);
        vm.prank(payee);
        payLink.cancel(native);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.payNative{value: 1 ether}(native, nativeSig, "r");
    }

    function test_Cancel_SoldOutAndExpiredLinks() public {
        inv.maxPayments = 1;
        sig = _signInvoice(inv);
        key = _key(inv);
        vm.prank(payer);
        usdc.approve(address(payLink), USDC_25);
        vm.prank(payer);
        payLink.pay(inv, sig, USDC_25, "r");
        vm.warp(uint256(inv.validUntil) + 1);
        vm.prank(payee);
        payLink.cancel(inv);
        assertTrue(payLink.stateOf(key).cancelled);
    }

    function test_Cancel_ByContractPayee() public {
        Wallet1271 wallet = new Wallet1271(payee);
        inv.payee = address(wallet);
        key = _key(inv);
        vm.expectEmit(true, true, false, true, address(payLink));
        emit IPayLinkV2.InvoiceCancelled(key, address(wallet));
        vm.prank(payee);
        wallet.execute(address(payLink), 0, abi.encodeCall(payLink.cancel, (inv)));
        assertTrue(payLink.stateOf(key).cancelled);
    }

    function test_RevertWhen_CancelByStranger() public {
        vm.prank(stranger);
        vm.expectRevert(IPayLinkV2.NotPayee.selector);
        payLink.cancel(inv);
    }

    function test_RevertWhen_CancelByPayer() public {
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.NotPayee.selector);
        payLink.cancel(inv);
    }

    // ------------------------------------------------------------------ tx.origin is never authority (SWC-115)

    /// @notice I9 is about `msg.sender`: a caller other than the payee is refused even when the transaction was
    ///         originated by the payee.
    function test_RevertWhen_CancelByStrangerWithPayeeAsTxOrigin() public {
        vm.prank(stranger, payee); // msg.sender = stranger, tx.origin = payee
        vm.expectRevert(IPayLinkV2.NotPayee.selector);
        payLink.cancel(inv);
        assertFalse(payLink.stateOf(key).cancelled);
    }

    /// @notice SWC-115 phishing: the payee is lured into calling an attacker's contract, which calls `cancel` on the
    ///         payee's invoice. The lure is `msg.sender`, so the link stays payable.
    function test_RevertWhen_LuredPayeeWouldCancel() public {
        TxOriginLure lure = new TxOriginLure(address(payLink), abi.encodeCall(payLink.cancel, (inv)));
        vm.prank(payee, payee); // the victim's own transaction
        vm.expectRevert(IPayLinkV2.NotPayee.selector);
        lure.claim();
        assertFalse(payLink.stateOf(key).cancelled);

        vm.startPrank(payer);
        usdc.approve(address(payLink), USDC_25);
        payLink.pay(inv, sig, USDC_25, "r");
        vm.stopPrank();
        _assertState(key, 1, false, uint64(vm.getBlockTimestamp()), USDC_25);
    }

    /// @notice The same through a smart account the payee owns that is not the invoice's payee: the account is the
    ///         caller, not the payee, whoever originated the transaction.
    function test_RevertWhen_CancelThroughPayeeOwnedAccount() public {
        Wallet1271 account = new Wallet1271(payee);
        vm.prank(payee, payee);
        vm.expectRevert(IPayLinkV2.NotPayee.selector);
        account.execute(address(payLink), 0, abi.encodeCall(payLink.cancel, (inv)));
        assertFalse(payLink.stateOf(key).cancelled);
    }

    /// @notice A relayed `cancelBySig` from a transaction the payee originated still needs the payee's signature.
    function test_RevertWhen_CancelBySigWithPayeeAsTxOriginButForeignSignature() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory foreign = _signCancel(strangerKey, inv, deadline);
        vm.prank(relayer, payee);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(inv, deadline, foreign);
        assertFalse(payLink.stateOf(key).cancelled);
    }

    function test_RevertWhen_CancelledTwice() public {
        vm.startPrank(payee);
        payLink.cancel(inv);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.cancel(inv);
        vm.stopPrank();
    }

    function test_RevertWhen_CancelMalformedInvoice() public {
        inv.validAfter = 2;
        inv.validUntil = 1;
        vm.prank(payee);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.cancel(inv);
    }

    // ------------------------------------------------------------------ cancelBySig

    function test_CancelBySig_RelayedForPayee() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);
        vm.expectEmit(true, true, false, true, address(payLink));
        emit IPayLinkV2.InvoiceCancelled(key, payee);
        vm.prank(relayer);
        payLink.cancelBySig(inv, deadline, cancelSig);
        _assertState(key, 0, true, 0, 0);
    }

    function test_CancelBySig_DeadlineIsInclusive() public {
        uint256 deadline = vm.getBlockTimestamp() + 10;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);
        vm.warp(deadline);
        payLink.cancelBySig(inv, deadline, cancelSig);
        assertTrue(payLink.stateOf(key).cancelled);
    }

    function test_CancelBySig_ContractPayee() public {
        Wallet1271 wallet = new Wallet1271(payee);
        inv.payee = address(wallet);
        key = _key(inv);
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline); // owner's ECDSA through ERC-1271
        payLink.cancelBySig(inv, deadline, cancelSig);
        assertTrue(payLink.stateOf(key).cancelled);
    }

    function test_CancelBySig_PreApprovedHashOnContractPayee() public {
        Wallet1271 wallet = new Wallet1271(payee);
        inv.payee = address(wallet);
        key = _key(inv);
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        vm.prank(payee);
        wallet.approveHash(_cancelDigest(key, deadline, vm.getChainId(), address(payLink)), true);
        payLink.cancelBySig(inv, deadline, "");
        assertTrue(payLink.stateOf(key).cancelled);
    }

    function test_RevertWhen_CancelSigExpired() public {
        uint256 deadline = vm.getBlockTimestamp() - 1;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SignatureExpired.selector, deadline));
        payLink.cancelBySig(inv, deadline, cancelSig);
    }

    function test_RevertWhen_CancelSigByStranger() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory cancelSig = _signCancel(strangerKey, inv, deadline);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(inv, deadline, cancelSig);
    }

    function test_RevertWhen_CancelSigForOtherDeadline() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(inv, deadline + 1, cancelSig);
    }

    function test_RevertWhen_CancelSigForOtherInvoice() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        IPayLinkV2.Invoice memory other = _invoice(address(usdc), USDC_25);
        bytes memory cancelSig = _signCancel(payeeKey, other, deadline);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(inv, deadline, cancelSig);
    }

    /// @notice The invoice signature (Invoice type) is not a cancel signature (Cancel type), whatever the deadline.
    function test_RevertWhen_InvoiceSignatureReusedAsCancel() public {
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(inv, type(uint256).max, sig);
    }

    function test_RevertWhen_CancelSigHighS() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory cancelSig = _highS(_signCancel(payeeKey, inv, deadline));
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(inv, deadline, cancelSig);
    }

    function test_RevertWhen_CancelSigFromOtherDeployment() public {
        PayLinkV2 other = new PayLinkV2();
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory foreign = _sign(
            payeeKey,
            _cancelDigest(_keyFor(inv, vm.getChainId(), address(other)), deadline, vm.getChainId(), address(other))
        );
        other.cancelBySig(inv, deadline, foreign); // valid there
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(inv, deadline, foreign); // never here
    }

    function test_RevertWhen_CancelSigReplayed() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);
        payLink.cancelBySig(inv, deadline, cancelSig);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.cancelBySig(inv, deadline, cancelSig);
    }

    function test_RevertWhen_CancelBySigMalformedInvoice() public {
        inv.payee = address(0);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.cancelBySig(inv, vm.getBlockTimestamp(), "");
    }

    function test_RevertWhen_CancelBySigAfterCancel() public {
        vm.prank(payee);
        payLink.cancel(inv);
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.cancelBySig(inv, deadline, cancelSig);
    }
}
