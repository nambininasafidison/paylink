// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {FeeOnTransfer} from "../mocks/FeeOnTransfer.sol";
import {BaseTest} from "./BaseTest.sol";

/// @title PrecedenceHarness: builds payments that fail any chosen set of documented checks at once
/// @notice IPayLinkV2 (and invoice spec §7.2) promise integrators a fixed check order on every settlement path:
///         `InvalidInvoice`, `WrongPaymentPath`, `Cancelled`, `InvalidSignature`, `NotYetValid`, `Expired`,
///         `SoldOut`, `WrongAmount`, `SelfPayment`, then the token-side `ReceivedMismatch` / `PayeeShortPaid`. The SDK
///         decodes the first error into the message the payer sees, so a reordering is a behaviour change even when
///         every check still exists. Single-failure unit tests cannot see a reordering; this harness builds one
///         payment that fails *every* check in a bitmask simultaneously, so the reported error must be the first
///         failing check in the documented order.
/// @dev Construction keeps each selected condition failing on its own and every unselected condition passing:
///      - state-based checks (`Cancelled`, `SoldOut`) are written straight into the key's packed slot with
///        `vm.store` (slot 3, asserted by Storage.t.sol), so they combine with an invalid shape or signature, which
///        `cancel` or a real payment would refuse;
///      - `NotYetValid` and `Expired` cannot both hold on a well-formed invoice (`validUntil < validAfter` is
///        `InvalidInvoice`), so when both are selected `Expired` is dropped; nothing observable is lost, as only one
///        of them can ever be reported;
///      - the token-side check uses a 1% fee-on-transfer token charged on every leg: on the EIP-3009 path the receive
///        delta fails first (`ReceivedMismatch`), on the allowance paths the payee delta (`PayeeShortPaid`). It does
///        not apply to `payNative`.
abstract contract PrecedenceHarness is BaseTest {
    enum Path {
        Authorization,
        Allowance,
        Permit,
        Native
    }

    // Documented order (IPayLinkV2 NatSpec, invoice spec §7.2), then the token-side check.
    uint8 internal constant C_INVALID_INVOICE = 0;
    uint8 internal constant C_WRONG_PATH = 1;
    uint8 internal constant C_CANCELLED = 2;
    uint8 internal constant C_SIGNATURE = 3;
    uint8 internal constant C_NOT_YET_VALID = 4;
    uint8 internal constant C_EXPIRED = 5;
    uint8 internal constant C_SOLD_OUT = 6;
    uint8 internal constant C_WRONG_AMOUNT = 7;
    uint8 internal constant C_SELF_PAYMENT = 8;
    uint8 internal constant C_TOKEN_SIDE = 9;
    uint8 internal constant N_CHECKS = 10;

    uint256 internal constant STATES_SLOT = 3;
    uint32 internal constant SEATS = 3;
    uint128 internal constant AMOUNT = 1000e6;
    uint256 internal constant FEE_BPS = 100;

    FeeOnTransfer internal fot;

    struct Scenario {
        Path path;
        uint16 failing; // bitmask over C_* after normalisation
        IPayLinkV2.Invoice inv;
        bytes sig;
        address caller;
        uint256 value;
        bytes data;
        bytes expected; // empty = the payment must settle
    }

    function setUp() public virtual override {
        super.setUp();
        fot = new FeeOnTransfer(FEE_BPS, FeeOnTransfer.FeeMode.DeductFromAmount);
        vm.label(address(fot), "FeeOnTransfer");
    }

    function _has(uint16 mask, uint8 check) internal pure returns (bool) {
        return mask & (uint16(1) << check) != 0;
    }

    /// @dev Drops combinations that cannot be built (see the contract notes) and checks that do not apply to `path`.
    function _normalise(Path path, uint16 mask) internal pure returns (uint16) {
        mask &= uint16((1 << N_CHECKS) - 1);
        if (_has(mask, C_NOT_YET_VALID)) mask &= ~(uint16(1) << C_EXPIRED);
        if (path == Path.Native) mask &= ~(uint16(1) << C_TOKEN_SIDE);
        return mask;
    }

    /// @dev Builds the call for `path` failing exactly the checks in `mask` (after `_normalise`). `variant` picks
    ///      secondary shapes: which `InvalidInvoice` rule, fixed or open amount, prior payments, expiry or none.
    function _build(Path path, uint16 mask, uint256 variant) internal returns (Scenario memory s) {
        s.path = path;
        s.failing = _normalise(path, mask);
        uint16 f = s.failing;
        uint256 nowTs = vm.getBlockTimestamp();
        bool native = path == Path.Native;
        bool open = variant & 1 == 1;

        // ---- invoice fields
        s.inv.payee = payee;
        if (native) s.inv.token = _has(f, C_WRONG_PATH) ? address(usdc) : address(0);
        else if (_has(f, C_WRONG_PATH)) s.inv.token = address(0);
        else s.inv.token = _has(f, C_TOKEN_SIDE) ? address(fot) : address(usdc);
        s.inv.amount = open ? 0 : AMOUNT;
        s.inv.validAfter = uint64(_has(f, C_NOT_YET_VALID) ? nowTs + 1 hours : nowTs - 1 days);
        if (_has(f, C_EXPIRED)) s.inv.validUntil = uint64(nowTs - 1 hours);
        else s.inv.validUntil = (variant >> 1) & 1 == 1 ? 0 : uint64(nowTs + 1 days);
        s.inv.maxPayments = SEATS;
        s.inv.salt = keccak256(abi.encode("precedence", path, mask, variant));
        s.inv.memoHash = bytes32(0);
        if (_has(f, C_INVALID_INVOICE)) _breakShape(s.inv, variant >> 2);

        // ---- payee signature and on-chain state of the key
        bytes32 key = _key(s.inv);
        s.sig = _sign(_has(f, C_SIGNATURE) ? strangerKey : payeeKey, key);
        uint256 prior = _has(f, C_SOLD_OUT) ? SEATS : (variant >> 4) % SEATS;
        uint256 word = prior | (_has(f, C_CANCELLED) ? uint256(1) << 32 : 0);
        if (prior != 0) word |= (uint256(nowTs - 1) << 40) | (uint256(prior * AMOUNT) << 104);
        vm.store(address(payLink), keccak256(abi.encode(key, STATES_SLOT)), bytes32(word));

        // ---- payer, amount and the call
        bool self = _has(f, C_SELF_PAYMENT);
        address payerAddr = self ? payee : payer;
        uint256 payerPk = self ? payeeKey : payerKey;
        uint128 offered = _has(f, C_WRONG_AMOUNT) ? (open ? 0 : AMOUNT + 1) : AMOUNT;
        s.caller = path == Path.Authorization ? relayer : payerAddr;
        s.data = _calldata(s, payerAddr, payerPk, key, offered);
        s.expected = _expectedError(s, offered);
    }

    /// @dev One of the four shape rules of `_checkShape` (spec §7.2 #1), chosen by `which`. The reversed window would
    ///      also make `NotYetValid` or `Expired` true, which is fine: `InvalidInvoice` is reported first either way.
    function _breakShape(IPayLinkV2.Invoice memory inv, uint256 which) internal view {
        which %= 4;
        if (which == 0) {
            inv.payee = address(0);
        } else if (which == 1) {
            inv.payee = address(payLink);
        } else if (which == 2) {
            inv.token = address(payLink);
        } else {
            inv.validUntil = inv.validAfter - 1;
        }
    }

    function _calldata(Scenario memory s, address payerAddr, uint256 payerPk, bytes32 key, uint128 offered)
        internal
        returns (bytes memory)
    {
        bool realToken = s.inv.token == address(usdc) || s.inv.token == address(fot);
        if (s.path == Path.Native) {
            s.value = offered;
            vm.deal(payerAddr, payerAddr.balance + offered);
            return abi.encodeCall(payLink.payNative, (s.inv, s.sig, "precedence"));
        }
        if (realToken) {
            usdc.mint(payerAddr, offered);
            fot.mint(payerAddr, offered);
        }
        if (s.path == Path.Authorization) {
            IPayLinkV2.Authorization memory auth;
            if (realToken) {
                auth = _authorize(payerPk, s.inv.token, key, offered, "precedence", "salt");
            } else {
                // No token code to sign for: PayLink's own checks fail before any token call.
                auth.payer = payerAddr;
                auth.amount = offered;
            }
            return abi.encodeCall(payLink.payWithAuthorization, (s.inv, s.sig, auth));
        }
        if (s.path == Path.Allowance) {
            if (realToken) {
                vm.prank(payerAddr);
                FeeOnTransfer(s.inv.token).approve(address(payLink), offered);
            }
            return abi.encodeCall(payLink.pay, (s.inv, s.sig, offered, "precedence"));
        }
        IPayLinkV2.Permit memory p;
        if (realToken) p = _permit(payerPk, s.inv.token, offered, vm.getBlockTimestamp() + 1 hours);
        return abi.encodeCall(payLink.payWithPermit, (s.inv, s.sig, offered, "precedence", p));
    }

    /// @dev The first failing check in the documented order, as the contract must encode it; empty when none fails.
    function _expectedError(Scenario memory s, uint128 offered) internal pure returns (bytes memory) {
        uint16 f = s.failing;
        if (_has(f, C_INVALID_INVOICE)) return abi.encodeWithSelector(IPayLinkV2.InvalidInvoice.selector);
        if (_has(f, C_WRONG_PATH)) return abi.encodeWithSelector(IPayLinkV2.WrongPaymentPath.selector);
        if (_has(f, C_CANCELLED)) return abi.encodeWithSelector(IPayLinkV2.Cancelled.selector);
        if (_has(f, C_SIGNATURE)) return abi.encodeWithSelector(IPayLinkV2.InvalidSignature.selector);
        if (_has(f, C_NOT_YET_VALID)) {
            return abi.encodeWithSelector(IPayLinkV2.NotYetValid.selector, s.inv.validAfter);
        }
        if (_has(f, C_EXPIRED)) return abi.encodeWithSelector(IPayLinkV2.Expired.selector, s.inv.validUntil);
        if (_has(f, C_SOLD_OUT)) return abi.encodeWithSelector(IPayLinkV2.SoldOut.selector, SEATS);
        if (_has(f, C_WRONG_AMOUNT)) {
            return abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, s.inv.amount, offered);
        }
        if (_has(f, C_SELF_PAYMENT)) return abi.encodeWithSelector(IPayLinkV2.SelfPayment.selector);
        if (_has(f, C_TOKEN_SIDE)) {
            uint256 short = uint256(offered) - (uint256(offered) * FEE_BPS + 9999) / 10_000;
            bytes4 selector = s.path == Path.Authorization
                ? IPayLinkV2.ReceivedMismatch.selector
                : IPayLinkV2.PayeeShortPaid.selector;
            return abi.encodeWithSelector(selector, uint256(offered), short);
        }
        return "";
    }

    /// @dev Executes the scenario and asserts the exact outcome: the expected revert data, or a settled payment.
    function _run(Scenario memory s) internal {
        vm.prank(s.caller);
        (bool ok, bytes memory ret) = address(payLink).call{value: s.value}(s.data);
        string memory label =
            string.concat("path ", vm.toString(uint256(uint8(s.path))), " mask ", vm.toString(uint256(s.failing)));
        if (s.expected.length == 0) {
            assertTrue(ok, string.concat(label, ": nothing fails, the payment must settle"));
        } else {
            assertFalse(ok, string.concat(label, ": must revert"));
            assertEq(ret, s.expected, string.concat(label, ": first failing check in the documented order"));
        }
    }
}
