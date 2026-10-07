// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Mock3009} from "./Mock3009.sol";

/// @title RecipientDebit: EIP-3009 + EIP-2612 token whose transfers to one account move value the wrong way
/// @notice A transfer of `value` whose recipient is `debited` takes `value` from that recipient and gives it to the
///         sender, so the recipient's balance *decreases*. Every other transfer, and every mint, is standard. It
///         models the most hostile accounting a token can show PayLinkV2: a balance that falls during a transfer
///         that "succeeded".
/// @dev Test-only. PayLinkV2 measures credits with `_increase(before, afterwards)`, documented to report 0 when the
///      balance decreased (IPayLinkV2 `PayeeShortPaid`, `ReceivedMismatch`). Pointing `debited` at the payee
///      exercises `_pullExact` (allowance and permit paths) and `_pushExact` (EIP-3009 forward leg); pointing it at
///      PayLinkV2 exercises the EIP-3009 receive leg. A checked subtraction there would revert with Panic(0x11)
///      instead of the documented custom error.
contract RecipientDebit is Mock3009 {
    address public debited;

    constructor() Mock3009("Recipient Debit", "RDB", "2", 6) {}

    function setDebited(address account) external {
        debited = account;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && to == debited) {
            super._update(to, from, value);
        } else {
            super._update(from, to, value);
        }
    }
}
