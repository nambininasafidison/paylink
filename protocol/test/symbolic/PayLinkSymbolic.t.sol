// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {AcceptAll1271, SymbolicToken} from "./SymbolicMocks.sol";

/// @title PayLinkV2 symbolic properties (Halmos): conservation and the link state machine
/// @notice PAYLINK-V2-SPEC §4.1 scopes Halmos to conservation (I1, with the payee side of I6) and the state machine
///         (`payments`, `total`, `cancelled`, `lastPaidAt`). Every input named in a `check_` function's parameters is
///         symbolic, so each check is a bounded proof over all of its values, not a sample:
///         - conservation, on every settlement path: for every amount, every stray balance and every token behaviour
///           in `SymbolicToken`'s space (each leg debiting and crediting `value` plus or minus any amount), a payment
///           that succeeds leaves PayLink's balance exactly where it was and credits the payee exactly `amount`;
///         - the payment state machine: from any stored link state, `pay` succeeds if and only if the documented rules
///           hold (shape, not cancelled, window, cap, amount rule, no counter or total overflow), and then moves the
///           state to exactly (payments + 1, not cancelled, now, total + amount); otherwise the state is unchanged;
///         - revocation: `cancel` succeeds if and only if the caller is the payee and the link is not cancelled yet,
///           and only sets `cancelled`; a cancelled link refuses every payment path.
///         Not a proof about signatures: the payee is `AcceptAll1271` (ERC-1271 accepting every hash), so no ECDSA
///         runs symbolically, and `SymbolicToken` checks no EIP-3009 signature. Signatures are covered by the unit,
///         fuzz and invariant suites (I7, I8).
/// @dev Run (from protocol/, Halmos 0.3.3; results and mutant runs in protocol/audit/properties.md):
///      halmos --match-contract PayLinkSymbolicTest --solver-timeout-assertion 0   (pnpm run symbolic)
///      `forge test` ignores this contract (no `test` functions); `dynamic_test_linking = false` in foundry.toml is
///      what Halmos needs to load it.
contract PayLinkSymbolicTest is Test {
    /// @dev Storage slot of `PayLinkV2._states` (see test/unit/Storage.t.sol).
    uint256 internal constant STATES_SLOT = 3;
    address internal constant PAYER = address(0xA11CE);
    address internal constant RELAYER = address(0xBEEF);
    address internal constant STRANGER = address(0x5757);
    /// @dev The payer's balance: above any debit a skewed leg can take (amount and skew are both below 2^128).
    uint256 internal constant PAYER_FUNDS = 1 << 200;

    /// @notice Invoice terms the state-machine checks vary (payee, token, salt and memo are fixed).
    struct Terms {
        uint128 amount;
        uint64 validAfter;
        uint64 validUntil;
        uint32 maxPayments;
    }

    PayLinkV2 internal payLink;
    SymbolicToken internal token;
    AcceptAll1271 internal payee;

    function setUp() public {
        payLink = new PayLinkV2();
        token = new SymbolicToken(address(payLink));
        payee = new AcceptAll1271();
    }

    // ================================================================== conservation (I1, payee side of I6)

    /// @notice EIP-3009 path, both legs skewed arbitrarily: success implies PayLink's balance is unchanged and the
    ///         payee gained exactly `amount`. `directions` holds, from bit 0, whether the receive credit, the receive
    ///         debit, the forward credit and the forward debit are above (1) or below (0) `amount`.
    function check_payWithAuthorization_conservesAndCreditsExactly(
        uint128 amount,
        uint128 stray,
        uint128 payeeStart,
        uint128 receiveCredit,
        uint128 receiveDebit,
        uint128 pushCredit,
        uint128 pushDebit,
        uint8 directions
    ) public {
        _fund(stray, payeeStart);
        _skew(0, receiveCredit, receiveDebit, directions);
        _skew(1, pushCredit, pushDebit, directions >> 2);
        IPayLinkV2.Authorization memory auth;
        auth.payer = PAYER;
        auth.amount = amount;

        vm.prank(RELAYER);
        (bool ok,) = address(payLink)
            .call(abi.encodeCall(payLink.payWithAuthorization, (_openInvoice(address(token)), "", auth)));
        if (ok) _assertExact(stray, payeeStart, amount);
    }

    /// @notice Allowance path, the pull leg skewed arbitrarily.
    function check_pay_conservesAndCreditsExactly(
        uint128 amount,
        uint128 stray,
        uint128 payeeStart,
        uint128 pullCredit,
        uint128 pullDebit,
        uint8 directions
    ) public {
        _fund(stray, payeeStart);
        _skew(2, pullCredit, pullDebit, directions);
        vm.prank(PAYER);
        (bool ok,) = address(payLink).call(abi.encodeCall(payLink.pay, (_openInvoice(address(token)), "", amount, "")));
        if (ok) _assertExact(stray, payeeStart, amount);
    }

    /// @notice Permit path (the token has no `permit`, so the `try` fails and the standing allowance is used), the
    ///         pull leg skewed arbitrarily.
    function check_payWithPermit_conservesAndCreditsExactly(
        uint128 amount,
        uint128 stray,
        uint128 payeeStart,
        uint128 pullCredit,
        uint128 pullDebit,
        uint8 directions
    ) public {
        _fund(stray, payeeStart);
        _skew(2, pullCredit, pullDebit, directions);
        IPayLinkV2.Permit memory p;
        vm.prank(PAYER);
        (bool ok,) = address(payLink)
            .call(abi.encodeCall(payLink.payWithPermit, (_openInvoice(address(token)), "", amount, "", p)));
        if (ok) _assertExact(stray, payeeStart, amount);
    }

    /// @notice Native path, with forced ether already held by PayLink.
    function check_payNative_conservesAndCreditsExactly(uint128 value, uint128 stray, uint128 payeeStart) public {
        vm.deal(address(payLink), stray);
        vm.deal(address(payee), payeeStart);
        vm.deal(PAYER, value);

        vm.prank(PAYER);
        (bool ok,) =
            address(payLink).call{value: value}(abi.encodeCall(payLink.payNative, (_openInvoice(address(0)), "", "")));
        if (ok) {
            assertEq(address(payLink).balance, stray, "I1: PayLink's native balance changed");
            assertEq(address(payee).balance, uint256(payeeStart) + value, "I6: payee not credited exactly");
        }
    }

    // ================================================================== state machine

    /// @notice `pay` from any stored state, for any invoice terms, time and amount: success if and only if every rule
    ///         holds, then exactly one transition; on failure nothing changes.
    function check_pay_stateMachine(IPayLinkV2.LinkState memory prior, Terms memory terms, uint128 amount, uint64 nowTs)
        public
    {
        IPayLinkV2.Invoice memory inv =
            _invoice(address(token), terms.amount, terms.validAfter, terms.validUntil, terms.maxPayments);
        bytes32 key = payLink.invoiceKey(inv);
        _storeState(key, prior);
        vm.warp(nowTs);
        _fund(0, 0);

        vm.prank(PAYER);
        (bool ok,) = address(payLink).call(abi.encodeCall(payLink.pay, (inv, "", amount, "")));
        assertEq(ok, _payAllowed(prior, terms, amount, nowTs), "pay succeeded if and only if every rule holds");

        IPayLinkV2.LinkState memory expected = prior;
        if (ok) {
            expected.payments = prior.payments + 1;
            expected.total = prior.total + amount;
            expected.lastPaidAt = nowTs;
            assertEq(token.balanceOf(address(payee)), amount, "payee credited");
        }
        _assertState(payLink.stateOf(key), expected);
    }

    /// @notice `cancel` from any stored state: success if and only if the invoice is well formed, the caller is the
    ///         payee and the link is not cancelled yet; it sets `cancelled` and nothing else.
    function check_cancel_stateMachine(
        IPayLinkV2.LinkState memory prior,
        uint64 validAfter,
        uint64 validUntil,
        bool byPayee
    ) public {
        IPayLinkV2.Invoice memory inv = _invoice(address(token), 0, validAfter, validUntil, 0);
        bytes32 key = payLink.invoiceKey(inv);
        _storeState(key, prior);

        bool ok;
        bytes memory data = abi.encodeCall(payLink.cancel, (inv));
        if (byPayee) {
            (ok,) = payee.execute(address(payLink), data);
        } else {
            vm.prank(STRANGER, address(payee)); // the payee as transaction origin authorizes nothing
            (ok,) = address(payLink).call(data);
        }

        bool shapeOk = validUntil == 0 || validUntil >= validAfter;
        assertEq(ok, shapeOk && byPayee && !prior.cancelled, "cancel succeeded iff the payee revoked a live link");
        IPayLinkV2.LinkState memory expected = prior;
        expected.cancelled = prior.cancelled || ok;
        _assertState(payLink.stateOf(key), expected);
    }

    /// @notice A cancelled link refuses every payment path, whatever the amount and the time.
    function check_cancelledLinkRefusesEveryPath(uint8 path, uint128 amount, uint64 nowTs) public {
        bool native = path % 4 == 3;
        IPayLinkV2.Invoice memory inv = _openInvoice(native ? address(0) : address(token));
        bytes32 key = payLink.invoiceKey(inv);
        IPayLinkV2.LinkState memory dead = IPayLinkV2.LinkState({payments: 0, cancelled: true, lastPaidAt: 0, total: 0});
        _storeState(key, dead);
        vm.warp(nowTs);
        _fund(0, 0);
        vm.deal(PAYER, amount);

        IPayLinkV2.Authorization memory auth;
        auth.payer = PAYER;
        auth.amount = amount;
        IPayLinkV2.Permit memory p;
        bytes memory data;
        if (path % 4 == 0) data = abi.encodeCall(payLink.payWithAuthorization, (inv, "", auth));
        else if (path % 4 == 1) data = abi.encodeCall(payLink.pay, (inv, "", amount, ""));
        else if (path % 4 == 2) data = abi.encodeCall(payLink.payWithPermit, (inv, "", amount, "", p));
        else data = abi.encodeCall(payLink.payNative, (inv, "", ""));

        vm.prank(PAYER);
        (bool ok,) = address(payLink).call{value: native ? amount : 0}(data);
        assertFalse(ok, "I4: a cancelled link accepted a payment");
        _assertState(payLink.stateOf(key), dead);
    }

    // ================================================================== helpers

    function _openInvoice(address asset) internal view returns (IPayLinkV2.Invoice memory) {
        return _invoice(asset, 0, 0, 0, 0); // open amount, no window, unlimited
    }

    function _invoice(address asset, uint128 amount, uint64 validAfter, uint64 validUntil, uint32 maxPayments)
        internal
        view
        returns (IPayLinkV2.Invoice memory inv)
    {
        inv = IPayLinkV2.Invoice({
            payee: address(payee),
            token: asset,
            amount: amount,
            validAfter: validAfter,
            validUntil: validUntil,
            maxPayments: maxPayments,
            salt: keccak256("halmos"),
            memoHash: bytes32(0)
        });
    }

    /// @dev PayLink holds `stray`, the payee `payeeStart`; the payer holds far more than any skewed debit and has
    ///      approved PayLink without limit, so only PayLink's own checks can make a payment fail.
    function _fund(uint128 stray, uint128 payeeStart) internal {
        token.mint(address(payLink), stray);
        token.mint(address(payee), payeeStart);
        token.mint(PAYER, PAYER_FUNDS);
        vm.prank(PAYER);
        token.approve(address(payLink), type(uint256).max);
    }

    /// @dev Skews one leg: credit and debit move `value` plus (bit set) or minus (bit clear) the given amounts.
    function _skew(uint8 leg, uint128 credit, uint128 debit, uint8 directions) internal {
        token.setSkew(leg, credit, directions & 1 != 0, debit, directions & 2 != 0);
    }

    function _assertExact(uint128 stray, uint128 payeeStart, uint128 amount) internal view {
        assertEq(token.balanceOf(address(payLink)), stray, "I1: PayLink's balance changed");
        assertEq(token.balanceOf(address(payee)), uint256(payeeStart) + amount, "I6: payee not credited exactly");
    }

    /// @dev The documented rules of a payment (spec §3.3.3, IPayLinkV2), written independently of PayLinkV2: the shape
    ///      check, not cancelled, the time window, the cap, the amount rule, and no overflow of the 32-bit counter or
    ///      the 128-bit total. The payee signature always verifies here (`AcceptAll1271`) and the payer is funded.
    function _payAllowed(IPayLinkV2.LinkState memory prior, Terms memory terms, uint128 amount, uint64 nowTs)
        internal
        pure
        returns (bool)
    {
        bool shapeOk = terms.validUntil == 0 || terms.validUntil >= terms.validAfter;
        bool inWindow = nowTs >= terms.validAfter && (terms.validUntil == 0 || nowTs <= terms.validUntil);
        bool notSoldOut = terms.maxPayments == 0 || prior.payments < terms.maxPayments;
        bool amountOk = terms.amount == 0 ? amount != 0 : amount == terms.amount;
        bool noOverflow = prior.payments < type(uint32).max && uint256(prior.total) + amount <= type(uint128).max;
        return shapeOk && !prior.cancelled && inWindow && notSoldOut && amountOk && noOverflow;
    }

    /// @dev Writes a link state into PayLink's packed slot: payments (32) | cancelled (8) | lastPaidAt (64) |
    ///      total (128), from the low-order bits.
    function _storeState(bytes32 key, IPayLinkV2.LinkState memory st) internal {
        uint256 word = uint256(st.payments) | (st.cancelled ? uint256(1) << 32 : 0) | (uint256(st.lastPaidAt) << 40)
            | (uint256(st.total) << 104);
        vm.store(address(payLink), keccak256(abi.encode(key, STATES_SLOT)), bytes32(word));
    }

    function _assertState(IPayLinkV2.LinkState memory st, IPayLinkV2.LinkState memory expected) internal pure {
        assertEq(st.payments, expected.payments, "payments");
        assertEq(st.cancelled, expected.cancelled, "cancelled");
        assertEq(st.lastPaidAt, expected.lastPaidAt, "lastPaidAt");
        assertEq(st.total, expected.total, "total");
    }
}
