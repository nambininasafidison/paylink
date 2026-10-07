// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Storage discipline (spec §3.3.2, §3.3.6): exactly one slot per key, written lazily, packed as
///         payments (32) | cancelled (8) | lastPaidAt (64) | total (128) from the low-order bits.
contract StorageTest is BaseTest {
    /// @dev `forge inspect PayLinkV2 storageLayout`: slots 0-1 are EIP712's name/version fallbacks (unused, both
    ///      strings fit in ShortStrings), slot 2 is ReentrancyGuard._status, slot 3 is the `_states` mapping.
    uint256 internal constant GUARD_SLOT = 2;
    uint256 internal constant STATES_SLOT = 3;

    function _slotOf(bytes32 key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, STATES_SLOT));
    }

    function test_Eip712FallbackSlotsStayEmpty() public view {
        assertEq(vm.load(address(payLink), bytes32(0)), bytes32(0), "_nameFallback");
        assertEq(vm.load(address(payLink), bytes32(uint256(1))), bytes32(0), "_versionFallback");
        assertEq(uint256(vm.load(address(payLink), bytes32(GUARD_SLOT))), 1, "guard NOT_ENTERED");
    }

    function test_StateLivesInOnePackedSlot() public {
        IPayLinkV2.Invoice memory inv = _invoiceN(address(musd), 0, 0);
        bytes memory sig = _signInvoice(inv);
        bytes32 key = _key(inv);
        assertEq(vm.load(address(payLink), _slotOf(key)), bytes32(0), "lazy: nothing before first use");

        vm.startPrank(payer);
        musd.approve(address(payLink), type(uint256).max);
        payLink.pay(inv, sig, 3e18, "");
        vm.warp(vm.getBlockTimestamp() + 5);
        payLink.pay(inv, sig, 4e18, "");
        vm.stopPrank();
        vm.prank(payee);
        payLink.cancel(inv);

        uint256 word = uint256(vm.load(address(payLink), _slotOf(key)));
        assertEq(uint32(word), 2, "payments");
        assertEq(uint8(word >> 32), 1, "cancelled");
        assertEq(uint64(word >> 40), vm.getBlockTimestamp(), "lastPaidAt");
        assertEq(uint128(word >> 104), 7e18, "total");
        assertEq(word >> 232, 0, "high 24 bits unused");
        assertEq(vm.load(address(payLink), bytes32(uint256(_slotOf(key)) + 1)), bytes32(0), "no second slot");
    }

    /// @notice A payment writes exactly one storage slot of PayLink besides the reentrancy guard.
    function test_PaymentWritesOneSlot() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(musd), 1e18);
        bytes memory sig = _signInvoice(inv);
        vm.prank(payer);
        musd.approve(address(payLink), type(uint256).max);

        vm.record();
        vm.prank(payer);
        payLink.pay(inv, sig, 1e18, "");
        (, bytes32[] memory writes) = vm.accesses(address(payLink));

        for (uint256 i = 0; i < writes.length; ++i) {
            assertTrue(writes[i] == bytes32(GUARD_SLOT) || writes[i] == _slotOf(_key(inv)), "unexpected storage write");
        }
        assertEq(uint256(vm.load(address(payLink), bytes32(GUARD_SLOT))), 1, "guard reset to NOT_ENTERED");
    }

    function test_CancelWritesOneSlot() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(musd), 1e18);
        vm.record();
        vm.prank(payee);
        payLink.cancel(inv);
        (, bytes32[] memory writes) = vm.accesses(address(payLink));
        for (uint256 i = 0; i < writes.length; ++i) {
            assertTrue(writes[i] == bytes32(GUARD_SLOT) || writes[i] == _slotOf(_key(inv)));
        }
        assertEq(uint256(vm.load(address(payLink), _slotOf(_key(inv)))), uint256(1) << 32);
    }

    /// @notice Failed payments leave no trace (state is only ever written by a successful settlement or cancel).
    function test_RevertedPaymentWritesNothing() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(musd), 1e18);
        bytes memory sig = _signInvoice(inv);
        vm.prank(payer); // no allowance
        (bool ok,) = address(payLink).call(abi.encodeCall(payLink.pay, (inv, sig, 1e18, "")));
        assertFalse(ok);
        assertEq(vm.load(address(payLink), _slotOf(_key(inv))), bytes32(0));
    }
}
