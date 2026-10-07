// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {PayLinkProperties} from "./PayLinkProperties.sol";

/// @title The Echidna/Medusa property harness is live, not vacuous
/// @notice A property campaign in which no payment ever settles proves nothing. These tests drive
///         `PayLinkProperties` through every action once, on `forge test`, so a change that breaks the harness (an
///         action that always reverts, a payee approval that no longer matches the link id, a nonce computed
///         differently from PayLinkV2) fails here instead of turning the nightly runs silently green.
contract PayLinkPropertiesHarnessTest is Test {
    PayLinkProperties internal p;

    function setUp() public {
        vm.warp(1_791_158_400); // 2026-10-05
        p = new PayLinkProperties{value: 300 ether}();
    }

    /// @notice Seed invoices: 0 = standard token (payee actor 0), 1 = skewable token (actor 1), 2 = native (actor 2).
    function test_EveryPaymentPathSettles() public {
        p.pay(0, 1, 5);
        p.payWithPermit(0, 2, 7);
        p.payWithAuthorization(0, 1, 9, 0);
        p.payNative(2, 0, 11);
        p.payWithAuthorization(1, 2, 13, 0);
        assertEq(p.settled(), 5, "each path settled once");
        _assertAllProperties();
    }

    /// @notice The refusals the properties rely on actually happen: a tampered relay (I8), each skewed leg one unit
    ///         over (I1/I6), a payment after cancellation (I4), a cancellation by someone else (I9), replays on the
    ///         alternate deployment (I7) and plain transfers (I10).
    function test_RefusalsAreObserved() public {
        p.payWithAuthorization(0, 1, 9, 1); // amount changed after the payer's approval
        p.payWithAuthorization(0, 1, 9, 2); // payerRef changed
        p.payWithAuthorization(0, 1, 9, 3); // payerSalt changed
        p.reconfigureSkew(1, false, 0, true); // forward leg credits the payee one unit more
        p.payWithAuthorization(1, 2, 13, 0);
        p.reconfigureSkew(3, false, 0, false); // reset
        p.reconfigureSkew(1, true, 0, false); // forward leg debits PayLink one unit less
        p.payWithAuthorization(1, 2, 13, 0);
        p.reconfigureSkew(3, false, 0, false);
        p.reconfigureSkew(0, false, 0, true); // PayLink credited one unit more on receipt
        p.payWithAuthorization(1, 2, 13, 0);
        p.reconfigureSkew(3, false, 0, false);
        p.reconfigureSkew(2, false, 0, true); // transferFrom credits the payee one unit more
        p.pay(1, 2, 13);
        assertEq(p.settled(), 0, "nothing settled");

        p.cancel(0, 1); // actor 1 is not invoice 0's payee
        assertFalse(p.cancelledSeen(_key(0)));
        p.cancel(0, 0);
        assertTrue(p.cancelledSeen(_key(0)));
        p.pay(0, 1, 5);
        p.cancelBySig(2, 1, 1 days); // approved by actor 1, not the payee
        assertFalse(p.cancelledSeen(_key(2)));
        p.cancelBySig(2, 2, 1 days);
        assertTrue(p.cancelledSeen(_key(2)));

        p.replayOnAlternate(1, 0, false);
        p.replayOnAlternate(1, 0, true);
        p.sendToPayLink(1, false);
        p.sendToPayLink(1, true);
        p.donate(true, 1e6);
        assertEq(p.settled(), 0, "nothing settled");
        _assertAllProperties();
    }

    function _key(uint256 i) internal view returns (bytes32 key) {
        (, key,,) = p.entry(i);
    }

    function _assertAllProperties() internal view {
        assertTrue(p.echidna_I1_conservation(), "I1");
        assertTrue(p.echidna_I2_paymentsNeverExceedMax(), "I2");
        assertTrue(p.echidna_I3_totalsMatchPayments(), "I3");
        assertTrue(p.echidna_I4_noPaymentAfterCancel(), "I4");
        assertTrue(p.echidna_I5_paymentsInsideWindow(), "I5");
        assertTrue(p.echidna_I6_exactness(), "I6");
        assertTrue(p.echidna_I7_domainSeparation(), "I7");
        assertTrue(p.echidna_I8_authorizationBinding(), "I8");
        assertTrue(p.echidna_I9_onlyPayeeCancels(), "I9");
        assertTrue(p.echidna_I10_pathSeparation(), "I10");
        assertTrue(p.echidna_I11_monotonicState(), "I11");
        assertTrue(p.echidna_documentedChecksHold(), "SelfPayment");
    }
}
