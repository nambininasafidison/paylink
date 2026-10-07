// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IERC3009} from "../../src/interfaces/IERC3009.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {FeeOnTransfer} from "../mocks/FeeOnTransfer.sol";
import {OverCreditToken} from "../mocks/OverCreditToken.sol";
import {RecipientDebit} from "../mocks/RecipientDebit.sol";
import {Wallet1271} from "../mocks/Wallet1271.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice `payWithAuthorization`: EIP-3009 pass-through settlement, every revert path and every event field.
contract PayWithAuthorizationTest is BaseTest {
    bytes32 internal constant REF = bytes32("ORDER-1");
    bytes32 internal constant PSALT = bytes32("attempt-1");

    IPayLinkV2.Invoice internal inv;
    bytes internal sig;
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        inv = _invoice(address(usdc), USDC_25);
        sig = _signInvoice(inv);
        key = _key(inv);
    }

    function _auth() internal view returns (IPayLinkV2.Authorization memory) {
        return _authorize(payerKey, address(usdc), key, USDC_25, REF, PSALT);
    }

    // ------------------------------------------------------------------ success

    function test_PayWithAuthorization_RelayerSettlesToPayee() public {
        IPayLinkV2.Authorization memory auth = _auth();
        bytes32 nonce = _nonce(key, payer, USDC_25, REF, PSALT);

        // Effects before interactions: Paid first, then the token's events.
        vm.expectEmit(true, true, true, true, address(payLink));
        emit IPayLinkV2.Paid(key, payee, payer, address(usdc), USDC_25, 0, REF);
        vm.expectEmit(true, true, false, false, address(usdc));
        emit IERC3009.AuthorizationUsed(payer, nonce);
        vm.expectEmit(true, true, false, true, address(usdc));
        emit IERC20.Transfer(payer, address(payLink), USDC_25);
        vm.expectEmit(true, true, false, true, address(usdc));
        emit IERC20.Transfer(address(payLink), payee, USDC_25);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(relayer);
        uint32 index = payLink.payWithAuthorization(inv, sig, auth);

        assertEq(index, 0, "index");
        assertEq(usdc.balanceOf(payee), USDC_25, "payee credited");
        assertEq(payerBefore - usdc.balanceOf(payer), USDC_25, "payer debited");
        assertEq(usdc.balanceOf(address(payLink)), 0, "nothing retained");
        assertEq(usdc.balanceOf(relayer), 0, "relayer untouched");
        assertTrue(usdc.authorizationState(payer, nonce), "token nonce consumed");
        _assertState(key, 1, false, uint64(vm.getBlockTimestamp()), USDC_25);
    }

    function test_PayWithAuthorization_PayerCanSelfSubmit() public {
        IPayLinkV2.Authorization memory auth = _auth();
        vm.prank(payer);
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(usdc.balanceOf(payee), USDC_25);
    }

    function test_PayWithAuthorization_PayeeMayRelay() public {
        IPayLinkV2.Authorization memory auth = _auth();
        vm.prank(payee);
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(usdc.balanceOf(payee), USDC_25);
    }

    function test_PayWithAuthorization_SequentialIndexesAndTotal() public {
        inv = _invoiceN(address(usdc), USDC_25, 3);
        sig = _signInvoice(inv);
        key = _key(inv);
        for (uint32 i = 0; i < 3; ++i) {
            vm.warp(vm.getBlockTimestamp() + 60);
            IPayLinkV2.Authorization memory auth =
                _authorize(payerKey, address(usdc), key, USDC_25, REF, bytes32(uint256(i)));
            vm.expectEmit(true, true, true, true, address(payLink));
            emit IPayLinkV2.Paid(key, payee, payer, address(usdc), USDC_25, i, REF);
            vm.prank(relayer);
            assertEq(payLink.payWithAuthorization(inv, sig, auth), i);
        }
        _assertState(key, 3, false, uint64(vm.getBlockTimestamp()), 3 * USDC_25);

        IPayLinkV2.Authorization memory fourth =
            _authorize(payerKey, address(usdc), key, USDC_25, REF, bytes32(uint256(3)));
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SoldOut.selector, uint32(3)));
        payLink.payWithAuthorization(inv, sig, fourth);
    }

    function test_PayWithAuthorization_OpenAmount() public {
        inv = _invoiceN(address(usdc), 0, 0);
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, 7_500_000, REF, PSALT);
        vm.expectEmit(true, true, true, true, address(payLink));
        emit IPayLinkV2.Paid(key, payee, payer, address(usdc), 7_500_000, 0, REF);
        payLink.payWithAuthorization(inv, sig, auth);
        _assertState(key, 1, false, uint64(vm.getBlockTimestamp()), 7_500_000);
    }

    function test_PayWithAuthorization_ToDeployed1271Payee() public {
        Wallet1271 wallet = new Wallet1271(payee);
        inv.payee = address(wallet);
        key = _key(inv);
        sig = _sign(payeeKey, key); // the wallet owner's ECDSA signature, checked through ERC-1271
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, USDC_25, REF, PSALT);
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(usdc.balanceOf(address(wallet)), USDC_25);
    }

    function test_PayWithAuthorization_WindowBoundariesAreInclusive() public {
        inv.validAfter = uint64(vm.getBlockTimestamp() + 100);
        inv.validUntil = uint64(vm.getBlockTimestamp() + 100);
        inv.maxPayments = 0;
        sig = _signInvoice(inv);
        key = _key(inv);
        vm.warp(vm.getBlockTimestamp() + 100);
        payLink.payWithAuthorization(inv, sig, _auth());
        assertEq(payLink.stateOf(key).payments, 1);
    }

    function test_PayWithAuthorization_ZeroValidUntilNeverExpires() public {
        inv.validUntil = 0;
        sig = _signInvoice(inv);
        key = _key(inv);
        vm.warp(type(uint64).max);
        payLink.payWithAuthorization(inv, sig, _authorize(payerKey, address(usdc), key, USDC_25, REF, PSALT));
        assertEq(payLink.stateOf(key).payments, 1);
    }

    // ------------------------------------------------------------------ InvalidInvoice

    function test_RevertWhen_PayeeIsZero() public {
        inv.payee = address(0);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_PayeeIsPayLink() public {
        inv.payee = address(payLink);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_TokenIsPayLink() public {
        inv.token = address(payLink);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_ValidUntilBeforeValidAfter() public {
        inv.validAfter = uint64(vm.getBlockTimestamp() + 2);
        inv.validUntil = uint64(vm.getBlockTimestamp() + 1);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    // ------------------------------------------------------------------ path

    function test_RevertWhen_InvoiceIsNative() public {
        inv.token = address(0);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.WrongPaymentPath.selector);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    // ------------------------------------------------------------------ state, signature, window, cap, amount

    function test_RevertWhen_Cancelled() public {
        vm.prank(payee);
        payLink.cancel(inv);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_SignedByStranger() public {
        sig = _sign(strangerKey, key);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_SignatureIsForAnotherInvoice() public {
        IPayLinkV2.Invoice memory other = _invoice(address(usdc), USDC_25);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payWithAuthorization(inv, _signInvoice(other), auth);
    }

    function test_RevertWhen_InvoiceFieldTampered() public {
        inv.amount = 1; // a payer cannot lower a signed price
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), _key(inv), 1, REF, PSALT);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_SignatureIsHighS() public {
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payWithAuthorization(inv, _highS(sig), auth);
    }

    function test_RevertWhen_SignatureIsEmpty() public {
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payWithAuthorization(inv, "", auth);
    }

    function test_RevertWhen_NotYetValid() public {
        inv.validAfter = uint64(vm.getBlockTimestamp() + 1);
        sig = _signInvoice(inv);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.NotYetValid.selector, inv.validAfter));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_Expired() public {
        vm.warp(uint256(inv.validUntil) + 1);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.Expired.selector, inv.validUntil));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_SoldOut() public {
        payLink.payWithAuthorization(inv, sig, _auth());
        IPayLinkV2.Authorization memory again = _authorize(payerKey, address(usdc), key, USDC_25, REF, "attempt-2");
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SoldOut.selector, uint32(1)));
        payLink.payWithAuthorization(inv, sig, again);
    }

    function test_RevertWhen_AmountDiffersFromFixedAmount() public {
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, USDC_25 - 1, REF, PSALT);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, USDC_25, USDC_25 - 1));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_OpenAmountIsZero() public {
        inv.amount = 0;
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, 0, REF, PSALT);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(0), uint128(0)));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_PayerIsPayee() public {
        usdc.mint(payee, USDC_25);
        IPayLinkV2.Authorization memory auth = _authorize(payeeKey, address(usdc), key, USDC_25, REF, PSALT);
        vm.expectRevert(IPayLinkV2.SelfPayment.selector);
        payLink.payWithAuthorization(inv, sig, auth);
    }

    // ------------------------------------------------------------------ token-side failures

    function test_RevertWhen_AuthorizationReplayed() public {
        inv.maxPayments = 2;
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, USDC_25, REF, PSALT);
        payLink.payWithAuthorization(inv, sig, auth);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_AuthorizationCancelledByPayer() public {
        IPayLinkV2.Authorization memory auth = _auth();
        bytes32 nonce = _nonce(key, payer, USDC_25, REF, PSALT);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), payer, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        usdc.cancelAuthorization(payer, nonce, v, r, s);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_AuthorizationExpired() public {
        IPayLinkV2.Authorization memory auth = _auth();
        vm.warp(auth.validBefore);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_AuthorizationNotYetValid() public {
        IPayLinkV2.Authorization memory auth = _auth();
        auth.validAfter = vm.getBlockTimestamp(); // the token requires now > validAfter
        _signAuthorization(payerKey, address(usdc), auth, _nonce(key, payer, USDC_25, REF, PSALT));
        vm.expectRevert(bytes("FiatTokenV2: authorization is not yet valid"));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_PayerBalanceInsufficient() public {
        IPayLinkV2.Authorization memory auth = _authorize(strangerKey, address(usdc), key, USDC_25, REF, PSALT);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, stranger, 0, USDC_25));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_TokenHasNoCode() public {
        inv.token = makeAddr("not-a-token");
        sig = _signInvoice(inv);
        IPayLinkV2.Authorization memory auth = _auth();
        vm.expectRevert(bytes(""));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    // ------------------------------------------------------------------ relayer-redirect attack (I8)

    /// @notice A relayer holding a payer's authorization for invoice A cannot settle anything else with it: not
    ///         another invoice, amount, reference, salt or payer, and not on another PayLink deployment. The
    ///         token rejects the signature because the recomputed nonce (or `to`) differs.
    function test_RelayerCannotRedirectAuthorization() public {
        inv.amount = 0; // open invoice, so a changed amount is not caught by WrongAmount first
        inv.maxPayments = 0;
        sig = _signInvoice(inv);
        key = _key(inv);
        // The attacker controls payee B and signs an otherwise identical invoice for themselves.
        IPayLinkV2.Invoice memory invB = inv;
        invB.payee = stranger;
        bytes memory sigB = _sign(strangerKey, _key(invB));
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, USDC_25, REF, PSALT);

        vm.startPrank(relayer);
        // Another link.
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        payLink.payWithAuthorization(invB, sigB, auth);

        // Another amount.
        IPayLinkV2.Authorization memory forged = _clone(auth);
        forged.amount = USDC_25 + 1;
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        payLink.payWithAuthorization(inv, sig, forged);

        // Another payer reference.
        forged = _clone(auth);
        forged.payerRef = bytes32("ORDER-2");
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        payLink.payWithAuthorization(inv, sig, forged);

        // Another payer salt.
        forged = _clone(auth);
        forged.payerSalt = bytes32("attempt-2");
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        payLink.payWithAuthorization(inv, sig, forged);

        // Another payer (debit someone else).
        usdc.mint(stranger, USDC_25);
        forged = _clone(auth);
        forged.payer = stranger;
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        payLink.payWithAuthorization(inv, sig, forged);

        // Another time window.
        forged = _clone(auth);
        forged.validBefore = auth.validBefore + 1;
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        payLink.payWithAuthorization(inv, sig, forged);
        vm.stopPrank();

        // Another PayLink deployment with the identical invoice: the authorization names PayLink A as `to`.
        vm.prank(relayer);
        PayLinkV2 other = new PayLinkV2();
        bytes memory sigOther = _sign(payeeKey, _keyFor(inv, vm.getChainId(), address(other)));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        other.payWithAuthorization(inv, sigOther, auth);

        // Nothing moved; the honest submission still settles exactly as signed.
        assertEq(usdc.balanceOf(stranger), USDC_25, "attacker unpaid");
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(usdc.balanceOf(payee), USDC_25, "payee paid");
        assertEq(usdc.balanceOf(stranger), USDC_25, "attacker still unpaid");
    }

    // ------------------------------------------------------------------ exact-delta checks

    function test_RevertWhen_TokenTakesFeeOnReceive() public {
        FeeOnTransfer fot = new FeeOnTransfer(100, FeeOnTransfer.FeeMode.DeductFromAmount); // 1%
        fot.mint(payer, 1000e6);
        inv.token = address(fot);
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(fot), key, USDC_25, REF, PSALT);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, USDC_25, USDC_25 - 250_000));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_TokenDeliversNothing() public {
        FeeOnTransfer fot = new FeeOnTransfer(10_000, FeeOnTransfer.FeeMode.DeductFromAmount); // 100%
        fot.mint(payer, 1000e6);
        inv.token = address(fot);
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(fot), key, USDC_25, REF, PSALT);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, USDC_25, 0));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function test_RevertWhen_TokenTakesFeeOnForward() public {
        FeeOnTransfer fot = new FeeOnTransfer(100, FeeOnTransfer.FeeMode.DeductFromAmount);
        fot.setExempt(address(payLink), true); // PayLink receives in full, the payee does not
        fot.mint(payer, 1000e6);
        inv.token = address(fot);
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(fot), key, USDC_25, REF, PSALT);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, USDC_25 - 250_000));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    /// @notice A token that charges the sender on top of the amount would make PayLink pay the fee out of stray
    ///         donations; the conservation post-check refuses.
    function test_RevertWhen_TokenWouldSpendDonations() public {
        FeeOnTransfer fot = new FeeOnTransfer(100, FeeOnTransfer.FeeMode.ChargeSender);
        fot.setExempt(address(payLink), true);
        fot.mint(payer, 1000e6);
        fot.mint(address(payLink), 1e6); // stray donation
        inv.token = address(fot);
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(fot), key, USDC_25, REF, PSALT);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, 1e6, 1e6 - 250_000));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    /// @notice Forward leg (`_pushExact`): the payee's balance falls during the forward transfer. Reported as
    ///         `PayeeShortPaid(amount, 0)`, before the conservation post-check.
    function test_RevertWhen_PayeeBalanceDecreasesOnForward() public {
        RecipientDebit rdb = new RecipientDebit();
        rdb.mint(payer, 1000e6);
        rdb.mint(payee, 1000e6);
        rdb.setDebited(payee);
        inv.token = address(rdb);
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(rdb), key, USDC_25, REF, PSALT);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, 0));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    /// @notice Receive leg: PayLink's own balance falls during `receiveWithAuthorization` (it holds a stray donation
    ///         the token takes back). Reported as `ReceivedMismatch(amount, 0)`.
    function test_RevertWhen_PayLinkBalanceDecreasesOnReceive() public {
        RecipientDebit rdb = new RecipientDebit();
        rdb.mint(payer, 1000e6);
        rdb.mint(address(payLink), 1000e6); // stray donation the receive leg debits
        rdb.setDebited(address(payLink));
        inv.token = address(rdb);
        sig = _signInvoice(inv);
        key = _key(inv);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(rdb), key, USDC_25, REF, PSALT);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, USDC_25, 0));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    // ------------------------------------------------------------------ exactness in the over-credit direction

    /// @dev Over-credit token armed on one leg by `bonus`, a fresh invoice for it, and a stray donation of `stray`
    ///      already held by PayLink (so that the receive check and the conservation post-check report different
    ///      arguments, and each test pins which one fired).
    function _overCredit(OverCreditToken.Mode mode, uint256 bonus, uint256 stray)
        internal
        returns (OverCreditToken oct, IPayLinkV2.Authorization memory auth)
    {
        oct = new OverCreditToken();
        oct.mint(payer, 1000e6);
        if (stray != 0) oct.mint(address(payLink), stray);
        oct.arm(mode, address(payLink), bonus);
        inv.token = address(oct);
        sig = _signInvoice(inv);
        key = _key(inv);
        auth = _authorize(payerKey, address(oct), key, USDC_25, REF, PSALT);
    }

    /// @notice Receive leg: PayLink is credited one unit more than authorized. The receive check is an equality and
    ///         reports `ReceivedMismatch(amount, amount + 1)` itself; a check weakened to `received < amount` would
    ///         let the call reach the post-check (`ReceivedMismatch(stray, stray + 1)`), and weakening both would let
    ///         PayLink keep the surplus.
    function test_RevertWhen_PayLinkReceivesMoreThanAuthorized() public {
        (OverCreditToken oct, IPayLinkV2.Authorization memory auth) =
            _overCredit(OverCreditToken.Mode.BonusOnReceive, 1, 1e6);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, USDC_25, USDC_25 + 1));
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(oct.balanceOf(address(payLink)), 1e6, "PayLink keeps nothing");
    }

    /// @notice Forward leg (`_pushExact`): the payee is credited one unit more while PayLink is debited exactly
    ///         `amount`, so the conservation post-check alone would pass. `PayeeShortPaid(amount, amount + 1)`.
    function test_RevertWhen_PayeeOverCreditedOnForward() public {
        (OverCreditToken oct, IPayLinkV2.Authorization memory auth) =
            _overCredit(OverCreditToken.Mode.BonusOnPush, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, USDC_25, USDC_25 + 1));
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(oct.balanceOf(payee), 0);
    }

    /// @notice Conservation post-check (I1 in the growth direction): receipt and payee credit are both exact, but the
    ///         forward debits PayLink one unit less, so its balance would end one unit above where it started:
    ///         `ReceivedMismatch(balanceBefore, balanceBefore + 1)`.
    function test_RevertWhen_PayLinkBalanceWouldGrow() public {
        (OverCreditToken oct, IPayLinkV2.Authorization memory auth) =
            _overCredit(OverCreditToken.Mode.UnderDebitOnPush, 1, 1e6);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, 1e6, 1e6 + 1));
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(oct.balanceOf(address(payLink)), 1e6);
    }

    /// @notice The same with no stray balance: PayLink, holding nothing, would end holding one unit.
    function test_RevertWhen_PayLinkBalanceWouldGrowFromZero() public {
        (, IPayLinkV2.Authorization memory auth) = _overCredit(OverCreditToken.Mode.UnderDebitOnPush, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, 0, 1));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    /// @notice Control: armed on a leg this path never uses (`BonusOnPull`), the over-credit token settles exactly,
    ///         so the reverts above come from the skewed leg alone.
    function test_OverCreditTokenSettlesWhenItsLegIsUnused() public {
        (OverCreditToken oct, IPayLinkV2.Authorization memory auth) =
            _overCredit(OverCreditToken.Mode.BonusOnPull, 1, 1e6);
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(oct.balanceOf(payee), USDC_25);
        assertEq(oct.balanceOf(address(payLink)), 1e6);
    }

    // ------------------------------------------------------------------ the payer is auth.payer (SWC-115)

    /// @notice Neither the submitter nor the transaction origin is the payer: a relayed call whose origin is the payee
    ///         settles from `auth.payer` (no `SelfPayment`), and `Paid` names `auth.payer`.
    function test_PayWithAuthorization_IgnoresTxOrigin() public {
        vm.expectEmit(true, true, true, true, address(payLink));
        emit IPayLinkV2.Paid(key, payee, payer, address(usdc), USDC_25, 0, REF);
        vm.prank(relayer, payee);
        payLink.payWithAuthorization(inv, sig, _auth());
        assertEq(usdc.balanceOf(payee), USDC_25);
    }

    function test_FeeTokenWithoutFeeSettles() public {
        FeeOnTransfer fot = new FeeOnTransfer(0, FeeOnTransfer.FeeMode.DeductFromAmount);
        fot.mint(payer, 1000e6);
        inv.token = address(fot);
        sig = _signInvoice(inv);
        key = _key(inv);
        payLink.payWithAuthorization(inv, sig, _authorize(payerKey, address(fot), key, USDC_25, REF, PSALT));
        assertEq(fot.balanceOf(payee), USDC_25);
    }
}
