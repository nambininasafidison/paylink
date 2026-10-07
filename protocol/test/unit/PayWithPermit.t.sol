// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {HookReentrant} from "../mocks/HookReentrant.sol";
import {OverCreditToken} from "../mocks/OverCreditToken.sol";
import {Rebasing} from "../mocks/Rebasing.sol";
import {RecipientDebit} from "../mocks/RecipientDebit.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice `payWithPermit`: EIP-2612 permit in try/catch after the effects, then the allowance path.
contract PayWithPermitTest is BaseTest {
    bytes32 internal constant REF = bytes32("CART-7");

    IPayLinkV2.Invoice internal inv;
    bytes internal sig;
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        inv = _invoice(address(musd), 25e18);
        sig = _signInvoice(inv);
        key = _key(inv);
    }

    function test_PayWithPermit_SingleTransaction() public {
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);

        vm.expectEmit(true, true, true, true, address(payLink));
        emit IPayLinkV2.Paid(key, payee, payer, address(musd), 25e18, 0, REF);
        vm.expectEmit(true, true, false, true, address(musd));
        emit IERC20.Approval(payer, address(payLink), 25e18);
        vm.expectEmit(true, true, false, true, address(musd));
        emit IERC20.Transfer(payer, payee, 25e18);

        vm.prank(payer);
        uint32 index = payLink.payWithPermit(inv, sig, 25e18, REF, p);

        assertEq(index, 0);
        assertEq(musd.balanceOf(payee), 25e18);
        assertEq(musd.allowance(payer, address(payLink)), 0, "permit allowance fully used");
        assertEq(musd.nonces(payer), 1, "permit consumed");
        _assertState(key, 1, false, uint64(vm.getBlockTimestamp()), 25e18);
    }

    function test_PayWithPermit_On3009TokenWithVersion2Domain() public {
        inv.token = address(usdc);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(usdc), USDC_25, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        payLink.payWithPermit(inv, sig, USDC_25, REF, p);
        assertEq(usdc.balanceOf(payee), USDC_25);
    }

    /// @notice Spec §5 threat 10: a griefer submits the payer's permit first. The payment still succeeds, using the
    ///         allowance the griefer's call created.
    function test_PayWithPermit_FrontRunPermitIsHarmless() public {
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(stranger);
        musd.permit(payer, address(payLink), 25e18, p.deadline, p.v, p.r, p.s);

        vm.prank(payer);
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
        assertEq(musd.balanceOf(payee), 25e18);
    }

    function test_PayWithPermit_InvalidPermitFallsBackToAllowance() public {
        vm.prank(payer);
        musd.approve(address(payLink), 25e18);
        IPayLinkV2.Permit memory garbage = IPayLinkV2.Permit({deadline: 0, v: 27, r: bytes32(0), s: bytes32(0)});
        vm.prank(payer);
        payLink.payWithPermit(inv, sig, 25e18, REF, garbage);
        assertEq(musd.balanceOf(payee), 25e18);
    }

    /// @notice A code-less token fails before any transfer. Solidity's pre-call code-size check of the `try`
    ///         statement reverts in PayLink itself (it is not caught by `catch`), with empty revert data, exactly
    ///         like `pay` on the same invoice; no state is written.
    function test_RevertWhen_TokenHasNoCode() public {
        inv.token = makeAddr("eoa-token");
        sig = _signInvoice(inv);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(bytes(""));
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
        _assertState(_key(inv), 0, false, 0, 0);
    }

    function test_PayWithPermit_TokenWithoutPermitUsesAllowance() public {
        Rebasing reb = new Rebasing();
        reb.mint(payer, 100e6);
        inv.token = address(reb);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        vm.prank(payer);
        reb.approve(address(payLink), USDC_25);
        IPayLinkV2.Permit memory none;
        vm.prank(payer);
        payLink.payWithPermit(inv, sig, USDC_25, REF, none);
        assertEq(reb.balanceOf(payee), USDC_25);
    }

    /// @notice Slither permit-ordering fix: the permit runs after the state write, so no state is written after
    ///         any external call. A token observing PayLink from inside `permit` already sees the payment.
    function test_PayWithPermit_PermitRunsAfterEffects() public {
        HookReentrant hook = new HookReentrant();
        hook.mint(payer, 100e6);
        inv.token = address(hook);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(hook), USDC_25, vm.getBlockTimestamp() + 1 hours);
        hook.arm(HookReentrant.Trigger.OnPermit, address(payLink), abi.encodeCall(payLink.stateOf, (key)), true);

        vm.prank(payer);
        payLink.payWithPermit(inv, sig, USDC_25, REF, p);

        assertTrue(hook.hookCalled() && hook.lastHookOk(), "hook ran");
        IPayLinkV2.LinkState memory seen = abi.decode(hook.lastHookReturn(), (IPayLinkV2.LinkState));
        assertEq(seen.payments, 1, "payment recorded before permit");
        assertEq(seen.total, USDC_25, "total recorded before permit");
    }

    // ------------------------------------------------------------------ reverts

    function test_RevertWhen_PermitInvalidAndNoAllowance() public {
        IPayLinkV2.Permit memory p = _permit(strangerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(payLink), 0, 25e18)
        );
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    function test_RevertWhen_PermitExpiredAndNoAllowance() public {
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() - 1);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(payLink), 0, 25e18)
        );
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    function test_RevertWhen_PermitForSmallerValue() public {
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 1e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        // The permit signs value = 1e18 but PayLink submits value = amount: the signature does not match.
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(payLink), 0, 25e18)
        );
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    function test_RevertWhen_InvoiceIsNative() public {
        inv.token = address(0);
        sig = _signInvoice(inv);
        IPayLinkV2.Permit memory p;
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.WrongPaymentPath.selector);
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    function test_RevertWhen_TokenIsPayLink() public {
        inv.token = address(payLink);
        IPayLinkV2.Permit memory p;
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    function test_RevertWhen_Cancelled() public {
        vm.prank(payee);
        payLink.cancel(inv);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    function test_RevertWhen_SignatureInvalid() public {
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payWithPermit(inv, _highS(sig), 25e18, REF, p);
    }

    function test_RevertWhen_NotYetValid() public {
        inv.validAfter = uint64(vm.getBlockTimestamp() + 5);
        sig = _signInvoice(inv);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.NotYetValid.selector, inv.validAfter));
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    function test_RevertWhen_Expired() public {
        vm.warp(uint256(inv.validUntil) + 1);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.Expired.selector, inv.validUntil));
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    function test_RevertWhen_SoldOut() public {
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
        p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SoldOut.selector, uint32(1)));
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    function test_RevertWhen_WrongAmount() public {
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 24e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(25e18), uint128(24e18)));
        payLink.payWithPermit(inv, sig, 24e18, REF, p);
    }

    function test_RevertWhen_PayerIsPayee() public {
        musd.mint(payee, 25e18);
        IPayLinkV2.Permit memory p = _permit(payeeKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payee);
        vm.expectRevert(IPayLinkV2.SelfPayment.selector);
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
    }

    /// @notice The permit path shares `_pullExact`: a payee balance that falls is `PayeeShortPaid(amount, 0)`.
    function test_RevertWhen_PayeeBalanceDecreases() public {
        RecipientDebit rdb = new RecipientDebit();
        rdb.mint(payer, 1000e6);
        rdb.mint(payee, 1000e6);
        rdb.setDebited(payee);
        inv.token = address(rdb);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(rdb), USDC_25, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, 0));
        payLink.payWithPermit(inv, sig, USDC_25, REF, p);
    }

    /// @notice `_pullExact` is an equality on the permit path too: a payee credited one base unit more than `amount`
    ///         is `PayeeShortPaid(amount, amount + 1)`.
    function test_RevertWhen_PayeeOverCredited() public {
        OverCreditToken oct = new OverCreditToken();
        oct.mint(payer, 1000e6);
        oct.arm(OverCreditToken.Mode.BonusOnPull, address(payLink), 1);
        inv.token = address(oct);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(oct), USDC_25, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, USDC_25 + 1));
        payLink.payWithPermit(inv, sig, USDC_25, REF, p);
        assertEq(oct.balanceOf(payee), 0);
    }

    // ------------------------------------------------------------------ the payer is msg.sender (SWC-115)

    /// @notice The permit's owner and the account debited are `msg.sender`, never `tx.origin`: the caller's own
    ///         permit settles from the caller, and the origin's balance, nonce and allowance are untouched.
    function test_PayWithPermit_PayerIsMsgSenderNotTxOrigin() public {
        musd.mint(stranger, 100e18);
        IPayLinkV2.Permit memory p = _permit(strangerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        uint256 payerBefore = musd.balanceOf(payer);

        vm.expectEmit(true, true, true, true, address(payLink));
        emit IPayLinkV2.Paid(key, payee, stranger, address(musd), 25e18, 0, REF);
        vm.prank(stranger, payer); // msg.sender = stranger, tx.origin = payer
        payLink.payWithPermit(inv, sig, 25e18, REF, p);

        assertEq(musd.balanceOf(stranger), 75e18, "msg.sender debited");
        assertEq(musd.nonces(stranger), 1, "msg.sender's permit consumed");
        assertEq(musd.balanceOf(payer), payerBefore, "tx.origin untouched");
        assertEq(musd.nonces(payer), 0, "tx.origin's nonce untouched");
    }

    /// @notice A permit signed by the transaction origin is not usable by another caller: PayLink submits it with
    ///         `owner = msg.sender`, so the signature does not match, and the caller has no allowance of its own.
    function test_RevertWhen_PermitSignedByTxOriginOnly() public {
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        uint256 payerBefore = musd.balanceOf(payer);
        vm.prank(stranger, payer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(payLink), 0, 25e18)
        );
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
        assertEq(musd.balanceOf(payer), payerBefore);
        assertEq(musd.nonces(payer), 0, "the origin's permit was not consumed");
    }

    function test_RevertWhen_RebasingRoundsDown() public {
        Rebasing reb = new Rebasing();
        reb.mint(payer, 100e6);
        reb.rebase(1.1e18);
        inv.token = address(reb);
        inv.amount = USDC_25;
        sig = _signInvoice(inv);
        vm.prank(payer);
        reb.approve(address(payLink), USDC_25);
        IPayLinkV2.Permit memory none;
        vm.prank(payer);
        // 25e6 * 1e18 / 1.1e18 = 22_727_272 shares, worth 24_999_999 units: one unit short.
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, USDC_25 - 1));
        payLink.payWithPermit(inv, sig, USDC_25, REF, none);
    }
}
