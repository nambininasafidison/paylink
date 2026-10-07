// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {GhostLedger} from "./GhostLedger.sol";
import {Handler} from "./Handler.sol";

/// @title PayLinkV2 invariants I1-I11 (spec §3.3.4; mapping in protocol/audit/invariants.md)
/// @notice Handler-based campaign: 3 actors, an ERC-1271 wallet payee, a relayer, a donor, Mock3009, MockPermit,
///         two FeeOnTransfer tokens (one charging every leg, one charging only PayLink's forward leg, in either fee
///         model), an OverCreditToken (one leg moves *more* than the amount, so I1 and I6 are exercised as the
///         equalities they are) and native, plus an alternate deployment. Payments and cancellations run under a
///         seeded `tx.origin`, often the payee's. Each `invariant_I<n>_*` asserts the property
///         directly on chain state where it can, and asserts that the handler recorded no per-call violation for
///         that ID (the first offending call is printed as the assertion message).
/// @dev Local profile: 64 runs x depth 128. CI profile: 256 runs x depth 128 (foundry.toml). `fail_on_revert` is on:
///      the handler never reverts by design, so any revert is a bug in the suite itself.
contract InvariantsTest is Test {
    uint256 internal constant T0 = 1_791_158_400; // 2026-10-05 00:00:00 UTC

    PayLinkV2 internal payLink;
    PayLinkV2 internal alt;
    Handler internal handler;
    GhostLedger internal ghost;

    function setUp() public {
        vm.warp(T0);
        payLink = new PayLinkV2();
        alt = new PayLinkV2();
        handler = new Handler(payLink, alt);
        ghost = handler.ghost();

        bytes4[] memory selectors = new bytes4[](15);
        selectors[0] = Handler.createInvoice.selector;
        selectors[1] = Handler.warp.selector;
        selectors[2] = Handler.payWithAuthorization.selector;
        selectors[3] = Handler.pay.selector;
        selectors[4] = Handler.payWithPermit.selector;
        selectors[5] = Handler.payNative.selector;
        selectors[6] = Handler.cancel.selector;
        selectors[7] = Handler.cancelBySig.selector;
        selectors[8] = Handler.donate.selector;
        selectors[9] = Handler.relayerRedirect.selector;
        selectors[10] = Handler.crossDomainReplay.selector;
        selectors[11] = Handler.wrongPath.selector;
        // Payments are the point of the campaign: give the cheapest ones a second ticket.
        selectors[12] = Handler.payWithAuthorization.selector;
        selectors[13] = Handler.reconfigureFee.selector;
        selectors[14] = Handler.reconfigureOverCredit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _noViolation(uint8 id) internal view {
        assertEq(ghost.violations(id), 0, ghost.firstViolation(id));
    }

    // ------------------------------------------------------------------ I1..I11

    /// @notice I1 relative conservation: across every call PayLink's balance is unchanged (neither lower nor higher),
    ///         for every token and for native; in absolute terms it equals exactly what was donated, and the alternate
    ///         deployment holds nothing.
    function invariant_I1_relativeConservation() public view {
        _noViolation(1);
        assertEq(handler.usdc().balanceOf(address(payLink)), ghost.donated(address(handler.usdc())), "usdc");
        assertEq(handler.musd().balanceOf(address(payLink)), ghost.donated(address(handler.musd())), "musd");
        assertEq(handler.fee().balanceOf(address(payLink)), ghost.donated(address(handler.fee())), "fee token");
        assertEq(
            handler.fwdFee().balanceOf(address(payLink)), ghost.donated(address(handler.fwdFee())), "forward-fee token"
        );
        assertEq(
            handler.overCredit().balanceOf(address(payLink)),
            ghost.donated(address(handler.overCredit())),
            "over-credit token"
        );
        assertEq(address(payLink).balance, ghost.donated(address(0)), "native");
        assertEq(handler.usdc().balanceOf(address(alt)) + address(alt).balance, 0, "alternate deployment");
    }

    /// @notice I2: `payments <= maxPayments` whenever `maxPayments > 0`.
    function invariant_I2_paymentsNeverExceedMax() public view {
        _noViolation(2);
        uint256 n = ghost.entryCount();
        for (uint256 i = 0; i < n; ++i) {
            IPayLinkV2.Invoice memory inv = ghost.invoiceAt(i);
            if (inv.maxPayments != 0) assertLe(payLink.stateOf(ghost.keyAt(i)).payments, inv.maxPayments);
        }
    }

    /// @notice I3: `total(key) == sum of Paid.amount(key)` and `payments(key) == number of Paid(key)`.
    function invariant_I3_totalsMatchPaidEvents() public view {
        _noViolation(3);
        uint256 n = ghost.entryCount();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 key = ghost.keyAt(i);
            IPayLinkV2.LinkState memory st = payLink.stateOf(key);
            assertEq(st.total, ghost.paidSum(key), "total != sum(Paid.amount)");
            assertEq(st.payments, ghost.paidEvents(key), "payments != count(Paid)");
        }
    }

    /// @notice I4: a cancelled key never receives another `Paid`; cancellation is visible on chain and in events.
    function invariant_I4_noPaymentAfterCancel() public view {
        _noViolation(4);
        uint256 n = ghost.entryCount();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 key = ghost.keyAt(i);
            assertEq(payLink.stateOf(key).cancelled, ghost.cancelEventSeen(key), "cancelled flag vs event");
        }
    }

    /// @notice I5: no `Paid` outside `[validAfter, validUntil]` (or before `validAfter` when `validUntil == 0`).
    function invariant_I5_paymentsInsideWindow() public view {
        _noViolation(5);
        uint256 n = ghost.entryCount();
        for (uint256 i = 0; i < n; ++i) {
            IPayLinkV2.Invoice memory inv = ghost.invoiceAt(i);
            uint64 lastPaidAt = payLink.stateOf(ghost.keyAt(i)).lastPaidAt;
            if (lastPaidAt == 0) continue;
            assertGe(lastPaidAt, inv.validAfter, "paid before validAfter");
            if (inv.validUntil != 0) assertLe(lastPaidAt, inv.validUntil, "paid after validUntil");
        }
    }

    /// @notice I6 exactness: each `Paid` moved exactly `amount` (payee +amount, payer -amount) on standard tokens;
    ///         fixed invoices settle exactly `inv.amount`; fee-on-transfer payments never settle. (The forward-fee
    ///         token may settle through the allowance paths in its ChargeSender mode, where the payee still gets
    ///         exactly `amount`; the handler checks that per call, and that it never settles through EIP-3009. The
    ///         over-credit token settles only on a path whose legs it leaves alone; the handler checks per call that
    ///         a payee credited more than `amount` never settles either.)
    function invariant_I6_exactDeltas() public view {
        _noViolation(6);
        uint256 n = ghost.entryCount();
        for (uint256 i = 0; i < n; ++i) {
            GhostLedger.Entry memory e = ghost.entry(i);
            IPayLinkV2.LinkState memory st = payLink.stateOf(e.key);
            if (e.inv.amount != 0) assertEq(st.total, uint256(e.inv.amount) * st.payments, "fixed amount");
            if (e.asset == GhostLedger.Asset.FeeToken) assertEq(st.payments, 0, "fee-on-transfer settled");
        }
    }

    /// @notice I7 domain separation: no signature for (chainId, PayLink) ever verified on the alternate deployment
    ///         or under another chain id; the alternate deployment holds no state for any invoice.
    function invariant_I7_domainSeparation() public view {
        _noViolation(7);
        uint256 n = ghost.entryCount();
        for (uint256 i = 0; i < n; ++i) {
            IPayLinkV2.LinkState memory st = alt.stateOf(alt.invoiceKey(ghost.invoiceAt(i)));
            assertEq(st.payments, 0);
            assertFalse(st.cancelled);
        }
    }

    /// @notice I8 binding: an authorization never settled a tuple other than the one it was signed for.
    function invariant_I8_authorizationBinding() public view {
        _noViolation(8);
    }

    /// @notice I9: only the payee cancels, by `msg.sender` or by a valid payee signature; a transaction the payee
    ///         originated (`tx.origin`) authorizes neither path.
    function invariant_I9_onlyPayeeCancels() public view {
        _noViolation(9);
    }

    /// @notice I10 path separation: native invoices only through `payNative`, ERC-20 invoices never through it;
    ///         `receive` and `fallback` always revert.
    function invariant_I10_pathSeparation() public view {
        _noViolation(10);
    }

    /// @notice I11 monotonic state: `payments`, `total` and `lastPaidAt` never decrease; `cancelled` never resets.
    function invariant_I11_monotonicState() public view {
        _noViolation(11);
    }

    /// @notice The handler's independent model predicted every outcome (success, or the exact revert data) and the
    ///         final state of every key.
    function invariant_ModelAgreesWithContract() public view {
        _noViolation(0);
    }

    /// @notice Campaign statistics, printed with -vv.
    function afterInvariant() external view {
        bytes32[] memory names = ghost.actionNames();
        for (uint256 i = 0; i < names.length; ++i) {
            console.log(_trim(names[i]), ghost.calls(names[i]));
        }
        uint256 n = ghost.entryCount();
        uint256 paid;
        uint256 cancelled;
        for (uint256 i = 0; i < n; ++i) {
            IPayLinkV2.LinkState memory st = payLink.stateOf(ghost.keyAt(i));
            paid += st.payments;
            if (st.cancelled) ++cancelled;
        }
        string[] memory outcomes = ghost.outcomeNames();
        for (uint256 i = 0; i < outcomes.length; ++i) {
            console.log(outcomes[i], ghost.outcomeCount(outcomes[i]));
        }
        console.log("invoices", n);
        console.log("payments settled", paid);
        console.log("links cancelled", cancelled);
    }

    function _trim(bytes32 name) internal pure returns (string memory) {
        uint256 len = 0;
        while (len < 32 && name[len] != 0) ++len;
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = name[i];
        }
        return string(out);
    }
}
