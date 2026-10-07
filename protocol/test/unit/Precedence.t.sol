// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {PrecedenceHarness} from "../utils/PrecedenceHarness.sol";

/// @notice Error precedence, deterministically: every pair of documented checks failing at once, on all four
///         settlement paths, reports the earlier check (IPayLinkV2 NatSpec; invoice spec §7.2, §9.2). Also every
///         single check alone, and the all-pass control. `testFuzz_FirstFailingCheckIsReported` (fuzz/Precedence.t.sol)
///         covers arbitrary subsets.
contract PrecedenceTest is PrecedenceHarness {
    /// @dev Every pair (and single) of checks for one path; each case runs from the same state.
    function _allPairs(Path path) internal {
        for (uint8 i = 0; i < N_CHECKS; ++i) {
            for (uint8 j = i; j < N_CHECKS; ++j) {
                uint16 mask = (uint16(1) << i) | (uint16(1) << j);
                for (uint256 variant = 0; variant < 2; ++variant) {
                    uint256 snapshot = vm.snapshotState();
                    // Spread the secondary shapes over the cases: shape rule, open or fixed, expiry, prior payments.
                    _run(_build(path, mask, (uint256(i) * 7 + j * 3 + variant * 5) ^ (variant << 1)));
                    vm.revertToState(snapshot);
                }
            }
        }
        _run(_build(path, 0, 0)); // control: nothing fails, the payment settles
    }

    function test_Precedence_AllPairs_PayWithAuthorization() public {
        _allPairs(Path.Authorization);
    }

    function test_Precedence_AllPairs_Pay() public {
        _allPairs(Path.Allowance);
    }

    function test_Precedence_AllPairs_PayWithPermit() public {
        _allPairs(Path.Permit);
    }

    function test_Precedence_AllPairs_PayNative() public {
        _allPairs(Path.Native);
    }

    /// @notice The audit's regression case, on every path: a cancelled link paid with a stranger's signature reports
    ///         `Cancelled` (the link state), not `InvalidSignature`.
    function test_Precedence_CancelledBeforeInvalidSignature() public {
        uint16 mask = (uint16(1) << C_CANCELLED) | (uint16(1) << C_SIGNATURE);
        for (uint8 path = 0; path < 4; ++path) {
            Scenario memory s = _build(Path(path), mask, 0);
            assertEq(s.expected, abi.encodeWithSelector(IPayLinkV2.Cancelled.selector));
            _run(s);
        }
    }

    /// @notice `payNative` with `msg.value` above 2^128 - 1 reports `WrongAmount(inv.amount, 2^128 - 1)` before
    ///         even the shape check (invoice spec §7.2, last paragraph).
    function test_Precedence_NativeValueOverflowBeforeShape() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(0), 1 ether);
        inv.payee = address(0);
        uint256 value = uint256(type(uint128).max) + 1;
        vm.deal(payer, value);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, uint128(1 ether), type(uint128).max));
        payLink.payNative{value: value}(inv, "", "");
    }

    // ------------------------------------------------------------------ revocation (invoice spec §9.2)

    /// @notice `cancel`: shape, then `NotPayee`, then `Cancelled`.
    function test_Precedence_Cancel() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), 1);
        vm.prank(payee);
        payLink.cancel(inv); // the key is now cancelled

        IPayLinkV2.Invoice memory broken = _clone(inv);
        broken.validUntil = broken.validAfter - 1;
        _store(_key(broken), uint256(1) << 32); // cancelled, and malformed
        vm.prank(stranger); // not the payee either
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector);
        payLink.cancel(broken);

        vm.prank(stranger);
        vm.expectRevert(IPayLinkV2.NotPayee.selector); // NotPayee before Cancelled
        payLink.cancel(inv);

        vm.prank(payee);
        vm.expectRevert(IPayLinkV2.Cancelled.selector);
        payLink.cancel(inv);
    }

    /// @notice `cancelBySig`: shape, then `SignatureExpired`, then `Cancelled`, then `InvalidSignature`.
    function test_Precedence_CancelBySig() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), 1);
        uint256 past = vm.getBlockTimestamp() - 1;
        uint256 future = vm.getBlockTimestamp() + 1 hours;
        _store(_key(inv), uint256(1) << 32); // already cancelled

        IPayLinkV2.Invoice memory broken = _clone(inv);
        broken.payee = address(payLink);
        bytes memory strangerSig = _signCancel(strangerKey, broken, past);
        vm.expectRevert(IPayLinkV2.InvalidInvoice.selector); // before an expired deadline and a bad signature
        payLink.cancelBySig(broken, past, strangerSig);

        strangerSig = _signCancel(strangerKey, inv, past);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SignatureExpired.selector, past)); // before Cancelled
        payLink.cancelBySig(inv, past, strangerSig);

        strangerSig = _signCancel(strangerKey, inv, future);
        vm.expectRevert(IPayLinkV2.Cancelled.selector); // before InvalidSignature
        payLink.cancelBySig(inv, future, strangerSig);

        IPayLinkV2.Invoice memory open = _invoice(address(usdc), 1);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(open, future, _signCancel(strangerKey, open, future));
    }

    function _store(bytes32 key, uint256 word) internal {
        vm.store(address(payLink), keccak256(abi.encode(key, STATES_SLOT)), bytes32(word));
    }
}
