// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {stdError} from "forge-std/StdError.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Amount rule and exact deltas (I6) across 6- and 18-decimal tokens and native, over the full uint128 range.
contract AmountFuzzTest is BaseTest {
    function setUp() public override {
        super.setUp();
        vm.prank(payer);
        musd.approve(address(payLink), type(uint256).max);
        vm.prank(payer);
        usdc.approve(address(payLink), type(uint256).max);
    }

    function _fund(address token, uint256 amount) internal {
        if (token == address(0)) vm.deal(payer, amount);
        else if (token == address(usdc)) usdc.mint(payer, amount);
        else musd.mint(payer, amount);
    }

    function _tokenOf(uint8 seed) internal view returns (address) {
        uint8 i = seed % 3;
        return i == 0 ? address(usdc) : i == 1 ? address(musd) : address(0);
    }

    function _balance(address token, address account) internal view returns (uint256) {
        if (token == address(0)) return account.balance;
        return IPayLinkV2Token(token).balanceOf(account);
    }

    /// @dev Pays through the path matching the token kind (3009 for usdc, allowance for musd, native otherwise).
    function _pay(IPayLinkV2.Invoice memory inv, uint128 amount) internal returns (bool ok, bytes memory ret) {
        bytes memory sig = _signInvoice(inv);
        if (inv.token == address(0)) {
            vm.prank(payer);
            return address(payLink).call{value: amount}(abi.encodeCall(payLink.payNative, (inv, sig, "f")));
        }
        if (inv.token == address(usdc)) {
            IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), _key(inv), amount, "f", "s");
            vm.prank(relayer);
            return address(payLink).call(abi.encodeCall(payLink.payWithAuthorization, (inv, sig, auth)));
        }
        vm.prank(payer);
        return address(payLink).call(abi.encodeCall(payLink.pay, (inv, sig, amount, "f")));
    }

    function testFuzz_FixedAmountSettlesOnlyExactly(uint8 tokenSeed, uint128 amount, uint128 offered, bool exact)
        public
    {
        address token = _tokenOf(tokenSeed);
        amount = uint128(bound(amount, 1, type(uint128).max));
        if (exact) offered = amount; // half the runs exercise the success path
        IPayLinkV2.Invoice memory inv = _invoice(token, amount);
        _fund(token, offered);

        uint256 payeeBefore = _balance(token, payee);
        uint256 payerBefore = _balance(token, payer);
        (bool ok, bytes memory ret) = _pay(inv, offered);

        if (offered == amount) {
            assertTrue(ok, "exact amount must settle");
            assertEq(_balance(token, payee) - payeeBefore, amount, "payee +amount");
            assertEq(payerBefore - _balance(token, payer), amount, "payer -amount");
            assertEq(payLink.stateOf(_key(inv)).total, amount);
        } else {
            assertFalse(ok);
            assertEq(ret, abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, amount, offered));
            assertEq(_balance(token, payee), payeeBefore, "payee untouched");
        }
        assertEq(_balance(token, address(payLink)), 0, "nothing retained");
    }

    function testFuzz_OpenAmountAcceptsAnyPositive(uint8 tokenSeed, uint128 offered) public {
        address token = _tokenOf(tokenSeed);
        IPayLinkV2.Invoice memory inv = _invoice(token, 0);
        _fund(token, offered);
        uint256 payeeBefore = _balance(token, payee);
        (bool ok, bytes memory ret) = _pay(inv, offered);
        if (offered == 0) {
            assertFalse(ok);
            assertEq(ret, abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(0), uint128(0)));
        } else {
            assertTrue(ok);
            assertEq(_balance(token, payee) - payeeBefore, offered);
            _assertState(_key(inv), 1, false, uint64(vm.getBlockTimestamp()), offered);
        }
    }

    function testFuzz_TotalIsTheSumOfPayments(uint8 tokenSeed, uint64[] calldata amounts) public {
        address token = _tokenOf(tokenSeed);
        IPayLinkV2.Invoice memory inv = _invoiceN(token, 0, 0);
        uint256 n = amounts.length > 12 ? 12 : amounts.length;
        uint128 sum;
        uint32 count;
        for (uint256 i = 0; i < n; ++i) {
            uint128 a = uint128(bound(amounts[i], 1, type(uint64).max));
            _fund(token, a);
            vm.warp(vm.getBlockTimestamp() + 1);
            if (token == address(usdc)) {
                IPayLinkV2.Authorization memory auth =
                    _authorize(payerKey, address(usdc), _key(inv), a, "f", bytes32(i));
                payLink.payWithAuthorization(inv, _signInvoice(inv), auth);
            } else {
                (bool ok,) = _pay(inv, a);
                assertTrue(ok);
            }
            sum += a;
            ++count;
        }
        _assertState(_key(inv), count, false, count == 0 ? 0 : uint64(vm.getBlockTimestamp()), sum);
    }

    /// @notice Checked arithmetic: a link whose cumulative total would exceed 2^128 - 1 stops accepting payments
    ///         instead of wrapping (keeps I3 exact).
    function testFuzz_TotalNeverWraps(uint128 first, uint128 second) public {
        first = uint128(bound(first, 1, type(uint128).max));
        second = uint128(bound(second, type(uint128).max - first + 1, type(uint128).max));
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 0, 0);
        bytes memory sig = _signInvoice(inv);
        vm.deal(payer, uint256(first) + second);
        vm.prank(payer);
        payLink.payNative{value: first}(inv, sig, "");
        vm.prank(payer);
        vm.expectRevert(stdError.arithmeticError);
        payLink.payNative{value: second}(inv, sig, "");
        assertEq(payLink.stateOf(_key(inv)).total, first);
    }

    /// @notice Checked arithmetic on `payments` (I3, I11), on every path: an unlimited link (`maxPayments == 0`) at
    ///         2^32 - 2 payments accepts exactly one more, with `index` 2^32 - 2, then stops with an arithmetic panic
    ///         instead of wrapping to 0, which would repeat `Paid.index` and break `payments == #Paid`. Unreachable in
    ///         practice (about 4.3e9 payments), but the guard is pinned here: `forge coverage` does not count overflow
    ///         checks as branches, so only a test like this one notices an `unchecked` block.
    function test_PaymentsCounterNeverWraps() public {
        for (uint8 path = 0; path < 4; ++path) {
            uint256 snapshot = vm.snapshotState();
            _assertPaymentsCounterSaturates(path);
            vm.revertToState(snapshot);
        }
    }

    /// @dev `forge inspect PayLinkV2 storageLayout`: the `_states` mapping is slot 3 (asserted by Storage.t.sol).
    uint256 internal constant STATES_SLOT = 3;

    function _assertPaymentsCounterSaturates(uint8 path) internal {
        address token = path == 3 ? address(0) : path == 0 ? address(usdc) : address(musd);
        IPayLinkV2.Invoice memory inv = _invoiceN(token, 0, 0);
        bytes memory sig = _signInvoice(inv);
        bytes32 key = _key(inv);
        vm.store(address(payLink), keccak256(abi.encode(key, STATES_SLOT)), bytes32(uint256(type(uint32).max - 1)));

        (bool ok, bytes memory ret) = _payThrough(path, inv, sig, 1, "last");
        assertTrue(ok, "the last representable payment settles");
        assertEq(abi.decode(ret, (uint32)), type(uint32).max - 1, "its index");
        assertEq(payLink.stateOf(key).payments, type(uint32).max);

        (ok, ret) = _payThrough(path, inv, sig, 1, "wrap");
        assertFalse(ok, "one more payment must not wrap the counter");
        assertEq(ret, stdError.arithmeticError);
        IPayLinkV2.LinkState memory st = payLink.stateOf(key);
        assertEq(st.payments, type(uint32).max, "payments unchanged");
        assertEq(st.total, 1, "total unchanged");
    }

    /// @dev 0 = payWithAuthorization (usdc), 1 = pay (musd), 2 = payWithPermit (musd), 3 = payNative.
    function _payThrough(uint8 path, IPayLinkV2.Invoice memory inv, bytes memory sig, uint128 amount, bytes32 salt)
        internal
        returns (bool, bytes memory)
    {
        if (path == 0) {
            IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), _key(inv), amount, "f", salt);
            vm.prank(relayer);
            return address(payLink).call(abi.encodeCall(payLink.payWithAuthorization, (inv, sig, auth)));
        }
        bytes memory data;
        if (path == 1) {
            data = abi.encodeCall(payLink.pay, (inv, sig, amount, "f"));
        } else if (path == 2) {
            IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), amount, vm.getBlockTimestamp() + 1 hours);
            data = abi.encodeCall(payLink.payWithPermit, (inv, sig, amount, "f", p));
        } else {
            data = abi.encodeCall(payLink.payNative, (inv, sig, "f"));
        }
        vm.prank(payer);
        return address(payLink).call{value: path == 3 ? amount : 0}(data);
    }

    function testFuzz_NativeValueAboveUint128IsRejected(uint256 value) public {
        value = bound(value, uint256(type(uint128).max) + 1, type(uint256).max);
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 0, 0);
        bytes memory sig = _signInvoice(inv);
        vm.deal(payer, value);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(0), type(uint128).max));
        payLink.payNative{value: value}(inv, sig, "");
    }
}

interface IPayLinkV2Token {
    function balanceOf(address account) external view returns (uint256);
}
