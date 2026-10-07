// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Time windows (I5), payment caps (I2), invoice shape and cancel deadlines, against a reference model.
contract WindowFuzzTest is BaseTest {
    /// @dev Reference model of the shape and window checks, in the contract's documented order.
    function _expectedWindowError(uint64 validAfter, uint64 validUntil, uint256 nowTs)
        internal
        pure
        returns (bytes memory)
    {
        if (validUntil != 0 && validUntil < validAfter) {
            return abi.encodeWithSelector(IPayLinkV2.InvalidInvoice.selector);
        }
        if (nowTs < validAfter) return abi.encodeWithSelector(IPayLinkV2.NotYetValid.selector, validAfter);
        if (validUntil != 0 && nowTs > validUntil) {
            return abi.encodeWithSelector(IPayLinkV2.Expired.selector, validUntil);
        }
        return "";
    }

    function testFuzz_WindowMatchesModel(uint64 validAfter, uint64 validUntil, uint64 nowTs) public {
        IPayLinkV2.Invoice memory inv = _invoice(address(0), 1 ether);
        inv.validAfter = validAfter;
        inv.validUntil = validUntil;
        bytes memory sig = _signInvoice(inv);
        vm.warp(nowTs);

        bytes memory expected = _expectedWindowError(validAfter, validUntil, nowTs);
        vm.prank(payer);
        (bool ok, bytes memory ret) =
            address(payLink).call{value: 1 ether}(abi.encodeCall(payLink.payNative, (inv, sig, "")));
        if (expected.length == 0) {
            assertTrue(ok, "inside the window must settle");
            assertEq(payLink.stateOf(_key(inv)).lastPaidAt, nowTs);
        } else {
            assertFalse(ok);
            assertEq(ret, expected);
        }
    }

    /// @notice Boundaries: exactly `validAfter` and exactly `validUntil` are inside; one second outside is not.
    function testFuzz_WindowEdgesAreInclusive(uint64 validAfter, uint64 length) public {
        validAfter = uint64(bound(validAfter, 1, type(uint64).max - 1));
        length = uint64(bound(length, 0, type(uint64).max - validAfter - 1));
        uint64 validUntil = validAfter + length;
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 1 ether, 0);
        inv.validAfter = validAfter;
        inv.validUntil = validUntil;
        bytes memory sig = _signInvoice(inv);

        vm.startPrank(payer);
        vm.warp(validAfter - 1);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.NotYetValid.selector, validAfter));
        payLink.payNative{value: 1 ether}(inv, sig, "");
        vm.warp(validAfter);
        payLink.payNative{value: 1 ether}(inv, sig, "");
        vm.warp(validUntil);
        payLink.payNative{value: 1 ether}(inv, sig, "");
        vm.warp(uint256(validUntil) + 1);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.Expired.selector, validUntil));
        payLink.payNative{value: 1 ether}(inv, sig, "");
        vm.stopPrank();
    }

    function testFuzz_CapIsEnforced(uint32 maxPayments, uint8 attempts) public {
        maxPayments = uint32(bound(maxPayments, 0, 24));
        attempts = uint8(bound(attempts, 1, 30));
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 1 wei, maxPayments);
        bytes memory sig = _signInvoice(inv);
        bytes32 key = _key(inv);

        for (uint32 i = 0; i < attempts; ++i) {
            vm.prank(payer);
            if (maxPayments != 0 && i >= maxPayments) {
                vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SoldOut.selector, maxPayments));
                payLink.payNative{value: 1 wei}(inv, sig, "");
            } else {
                assertEq(payLink.payNative{value: 1 wei}(inv, sig, ""), i, "index");
            }
            IPayLinkV2.LinkState memory st = payLink.stateOf(key);
            if (maxPayments != 0) assertLe(st.payments, maxPayments, "I2");
            assertEq(st.total, st.payments, "I3 (1 wei each)");
        }
    }

    /// @notice Every malformed shape is rejected by every entry point, before any other check.
    function testFuzz_MalformedShapeAlwaysRejected(uint8 kind, address anyAddress, uint64 a, uint64 b) public {
        IPayLinkV2.Invoice memory inv = _invoice(address(0), 0);
        kind = kind % 4;
        if (kind == 0) {
            inv.payee = address(0);
        } else if (kind == 1) {
            inv.payee = address(payLink);
        } else if (kind == 2) {
            inv.token = address(payLink);
            inv.payee = anyAddress == address(0) || anyAddress == address(payLink) ? payee : anyAddress;
        } else {
            // validUntil != 0 && validUntil < validAfter
            inv.validAfter = uint64(bound(a, 2, type(uint64).max));
            inv.validUntil = uint64(bound(b, 1, inv.validAfter - 1));
        }
        IPayLinkV2.Authorization memory auth;
        IPayLinkV2.Permit memory p;

        vm.startPrank(inv.payee);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.cancel(inv);
        vm.stopPrank();
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.cancelBySig(inv, type(uint256).max, "");
        vm.startPrank(payer);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.payNative{value: 1}(inv, "", "");
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.pay(inv, "", 1, "");
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.payWithPermit(inv, "", 1, "", p);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.payWithAuthorization(inv, "", auth);
        vm.stopPrank();
    }

    function testFuzz_CancelDeadline(uint256 deadline, uint64 nowTs) public {
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);
        vm.warp(nowTs);
        if (nowTs > deadline) {
            vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SignatureExpired.selector, deadline));
            payLink.cancelBySig(inv, deadline, cancelSig);
        } else {
            payLink.cancelBySig(inv, deadline, cancelSig);
            assertTrue(payLink.stateOf(_key(inv)).cancelled);
        }
    }
}
