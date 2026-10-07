// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Mock3009} from "./Mock3009.sol";

/// @title OverCreditToken: EIP-3009 + EIP-2612 token that moves *more* value than asked on one leg
/// @notice The mirror image of `FeeOnTransfer` and `RecipientDebit`, which only ever make a balance come up short.
///         Invariants I1 (PayLink's balance after a call equals its balance before) and I6 (payee delta = +amount)
///         are equalities, so each exactness check of PayLinkV2 must also refuse a delta *above* the amount. Each
///         mode makes exactly one of those checks see such a delta:
///         - `BonusOnReceive`: PayLink is credited `amount + bonus` by `receiveWithAuthorization` (the EIP-3009
///           receive check, `ReceivedMismatch(amount, amount + bonus)`);
///         - `BonusOnPull`: the payee is credited `amount + bonus` by `transferFrom` (`_pullExact` on the allowance
///           and permit paths, `PayeeShortPaid(amount, amount + bonus)`);
///         - `BonusOnPush`: the payee is credited `amount + bonus` by PayLink's forwarding `transfer` (`_pushExact`
///           on the EIP-3009 forward leg, `PayeeShortPaid(amount, amount + bonus)`);
///         - `UnderDebitOnPush`: PayLink's forwarding `transfer` credits the payee exactly but debits PayLink only
///           `amount - bonus`, so PayLink ends `bonus` above its starting balance (the conservation post-check,
///           `ReceivedMismatch(balanceBefore, balanceBefore + bonus)`).
///         The extra value is minted, so no third party's balance moves; mints and the `None` mode are standard.
/// @dev Test-only. The legs are told apart by `from`/`to` relative to the PayLink address passed to `arm`: a
///      transfer to it is the receive leg, a transfer from it is the push (forward) leg, any other transfer is a
///      pull (payer -> payee). Used by the unit suites, `test/audit/A05_OverCreditExactness.t.sol` and the invariant
///      handler (`Handler.reconfigureOverCredit`).
contract OverCreditToken is Mock3009 {
    enum Mode {
        None,
        BonusOnReceive,
        BonusOnPull,
        BonusOnPush,
        UnderDebitOnPush
    }

    Mode public mode;
    address public payLink;
    uint256 public bonus;

    constructor() Mock3009("Over Credit USD", "ocUSD", "2", 6) {}

    /// @notice Selects the skewed leg. `bonus` is the extra credit (or, for `UnderDebitOnPush`, the part of the debit
    ///         refunded to PayLink); it must not exceed the forwarded amount in that mode.
    function arm(Mode mode_, address payLink_, uint256 bonus_) external {
        mode = mode_;
        payLink = payLink_;
        bonus = bonus_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == address(0) || to == address(0) || mode == Mode.None) return;
        bool receiveLeg = to == payLink;
        bool pushLeg = from == payLink;
        if (mode == Mode.BonusOnReceive && receiveLeg) {
            super._update(address(0), to, bonus);
        } else if (mode == Mode.BonusOnPull && !receiveLeg && !pushLeg) {
            super._update(address(0), to, bonus);
        } else if (mode == Mode.BonusOnPush && pushLeg) {
            super._update(address(0), to, bonus);
        } else if (mode == Mode.UnderDebitOnPush && pushLeg) {
            super._update(address(0), from, bonus); // refund part of the debit: PayLink ends above its start
        }
    }
}
