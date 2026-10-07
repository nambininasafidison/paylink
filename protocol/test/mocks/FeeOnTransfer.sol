// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Mock3009} from "./Mock3009.sol";

/// @title FeeOnTransfer: EIP-3009 + EIP-2612 token that takes a fee on transfers
/// @notice Two fee models seen in the wild:
///         - `DeductFromAmount`: the recipient gets `value - fee` (the common fee-on-transfer pattern);
///         - `ChargeSender`: the recipient gets `value`, the sender pays `value + fee`.
///         Transfers to an `exempt` recipient, mints and burns carry no fee. The fee is rounded up, so any
///         non-zero transfer with a non-zero rate pays at least 1 base unit.
/// @dev Test-only. PayLinkV2 must reject the first model through its delta checks, and must not let the second
///      one spend PayLink's stray balance (3009 conservation post-check).
contract FeeOnTransfer is Mock3009 {
    enum FeeMode {
        DeductFromAmount,
        ChargeSender
    }

    address public constant FEE_SINK = address(0xFEE);

    uint256 public feeBps;
    FeeMode public mode;
    mapping(address account => bool) public exempt;

    constructor(uint256 feeBps_, FeeMode mode_) Mock3009("Fee Token", "FEE", "1", 6) {
        feeBps = feeBps_;
        mode = mode_;
    }

    function setFee(uint256 feeBps_, FeeMode mode_) external {
        feeBps = feeBps_;
        mode = mode_;
    }

    function setExempt(address account, bool isExempt) external {
        exempt[account] = isExempt;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || exempt[to] || feeBps == 0 || value == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps + 9999) / 10_000;
        if (mode == FeeMode.DeductFromAmount) {
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
        super._update(from, FEE_SINK, fee);
    }
}
