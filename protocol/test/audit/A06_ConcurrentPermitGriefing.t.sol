// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @title A-06: a front-run permit is harmless only while a single permit payment is in flight
/// @notice PAYLINK-V2-SPEC §5 threat 10 and invoice spec §14.9 state that a griefer who submits a payer's EIP-2612
///         permit first has "no effect", because `payWithPermit` runs the permit in try/catch and then uses the
///         allowance. That holds for one permit. EIP-2612 `permit` *sets* the allowance; it does not add to it. When
///         a payer has two `payWithPermit` transactions in flight on the same token (permit nonces n and n + 1, for
///         two invoices), a griefer who lands both permits first leaves an allowance of only the second value: the
///         first payment then spends from it and one of the two payments reverts. Nothing is stolen (PayLink only
///         pulls from `msg.sender`); the cost is one reverted transaction, charged at its full gas limit on Monad,
///         plus a re-sign.
///
///         Reach: the reference SDK reads `nonces(owner)` at the latest block (`readPermitNonce`), so it never signs
///         n + 1 while n is pending; with it, two concurrent permit payments already conflict without any griefer.
///         The finding is the unconditional "no effect" claim in the format spec, which binds every implementer, and
///         the missing client rule that would make it true: one permit payment in flight per (payer, token).
/// @dev Run: forge test --match-path 'test/audit/A06_ConcurrentPermitGriefing.t.sol' -vv
contract A06ConcurrentPermitGriefingTest is BaseTest {
    bytes32 internal constant REF = bytes32("A06");
    uint128 internal constant AMOUNT_A = 25e18;
    uint128 internal constant AMOUNT_B = 40e18;

    IPayLinkV2.Invoice internal invA;
    IPayLinkV2.Invoice internal invB;
    bytes internal sigA;
    bytes internal sigB;
    IPayLinkV2.Permit internal permitA; // nonce n
    IPayLinkV2.Permit internal permitB; // nonce n + 1
    uint256 internal deadline;

    function setUp() public override {
        super.setUp();
        invA = _invoice(address(musd), AMOUNT_A);
        invB = _invoice(address(musd), AMOUNT_B);
        sigA = _signInvoice(invA);
        sigB = _signInvoice(invB);
        deadline = vm.getBlockTimestamp() + 1 hours;
        uint256 n = musd.nonces(payer);
        permitA = _permitAt(payerKey, AMOUNT_A, n, deadline);
        permitB = _permitAt(payerKey, AMOUNT_B, n + 1, deadline);
    }

    /// @dev EIP-2612 permit payer -> PayLink with an explicit nonce (BaseTest's helper reads the current one).
    function _permitAt(uint256 ownerKey, uint256 value, uint256 nonce, uint256 deadline_)
        internal
        view
        returns (IPayLinkV2.Permit memory p)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                musd.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, vm.addr(ownerKey), address(payLink), value, nonce, deadline_))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        p = IPayLinkV2.Permit({deadline: deadline_, v: v, r: r, s: s});
    }

    /// @notice Control: without a griefer, both in-flight permit payments settle, in either order of value.
    function test_Control_TwoInFlightPermitPaymentsSettle() public {
        vm.startPrank(payer);
        payLink.payWithPermit(invA, sigA, AMOUNT_A, REF, permitA);
        payLink.payWithPermit(invB, sigB, AMOUNT_B, REF, permitB);
        vm.stopPrank();
        assertEq(musd.balanceOf(payee), uint256(AMOUNT_A) + AMOUNT_B);
    }

    /// @notice A griefer lands both permits from the mempool before the payer's two transactions. The allowance is
    ///         now AMOUNT_B (permit B overwrote permit A). Payment A succeeds from it and leaves AMOUNT_B - AMOUNT_A;
    ///         payment B's own permit fails (nonce used, swallowed by try/catch) and its `transferFrom` reverts.
    function test_Grief_FrontRunningBothPermitsRevertsOnePayment() public {
        // Griefer: two plain `permit` calls with the payer's signatures, copied from the pending transactions.
        vm.startPrank(stranger);
        musd.permit(payer, address(payLink), AMOUNT_A, deadline, permitA.v, permitA.r, permitA.s);
        musd.permit(payer, address(payLink), AMOUNT_B, deadline, permitB.v, permitB.r, permitB.s);
        vm.stopPrank();
        assertEq(musd.allowance(payer, address(payLink)), AMOUNT_B, "permit B overwrote permit A");

        vm.startPrank(payer);
        payLink.payWithPermit(invA, sigA, AMOUNT_A, REF, permitA); // succeeds: allowance B covers A
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector,
                address(payLink),
                uint256(AMOUNT_B - AMOUNT_A),
                uint256(AMOUNT_B)
            )
        );
        payLink.payWithPermit(invB, sigB, AMOUNT_B, REF, permitB);
        vm.stopPrank();

        assertEq(musd.balanceOf(payee), AMOUNT_A, "only one of the two payments settled");
        assertEq(payLink.stateOf(_key(invB)).payments, 0, "invoice B unpaid");
    }

    /// @notice Same griefing with the larger payment first (A = 40 with permit n, B = 25 with permit n + 1). The
    ///         griefer's two permits leave an allowance of 25, so payment A now reverts and payment B settles. Either
    ///         way exactly one of the two payments fails.
    function test_Grief_WhenFirstPaymentIsLarger_FirstPaymentReverts() public {
        // Re-sign with values swapped: A asks 40, B asks 25.
        invA.amount = AMOUNT_B;
        invB.amount = AMOUNT_A;
        sigA = _signInvoice(invA);
        sigB = _signInvoice(invB);
        uint256 n = musd.nonces(payer);
        permitA = _permitAt(payerKey, AMOUNT_B, n, deadline);
        permitB = _permitAt(payerKey, AMOUNT_A, n + 1, deadline);

        vm.startPrank(stranger);
        musd.permit(payer, address(payLink), AMOUNT_B, deadline, permitA.v, permitA.r, permitA.s);
        musd.permit(payer, address(payLink), AMOUNT_A, deadline, permitB.v, permitB.r, permitB.s);
        vm.stopPrank();

        vm.startPrank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(payLink), uint256(AMOUNT_A), uint256(AMOUNT_B)
            )
        );
        payLink.payWithPermit(invA, sigA, AMOUNT_B, REF, permitA);
        payLink.payWithPermit(invB, sigB, AMOUNT_A, REF, permitB); // succeeds from the overwritten allowance
        vm.stopPrank();
        assertEq(musd.balanceOf(payee), AMOUNT_A, "only one of the two payments settled");
    }
}
