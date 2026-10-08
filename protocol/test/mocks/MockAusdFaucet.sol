// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Mock3009} from "./Mock3009.sol";

/// @title MockAusdFaucet: stands in for Monad testnet's AUSD faucet in the relayer's tests
/// @notice `requestFunds(recipient)` mints a fixed drip to the recipient, at most once per cooldown for everyone: the
///         live faucet (0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C) keeps one global cooldown, as observed on an anvil
///         fork of Monad testnet on 2026-10-07 (packages/chains/src/chains/monad-testnet.ts).
/// @dev Test-only. Used by apps/relayer/test (onboarding); no PayLinkV2 test depends on it.
contract MockAusdFaucet {
    Mock3009 public immutable TOKEN;
    uint256 public immutable DRIP;
    uint256 public immutable COOLDOWN;
    uint256 public lastRequest;

    error CooldownActive(uint256 readyAt);

    constructor(Mock3009 token, uint256 drip, uint256 cooldown) {
        TOKEN = token;
        DRIP = drip;
        COOLDOWN = cooldown;
    }

    function requestFunds(address recipient) external {
        if (lastRequest != 0 && block.timestamp < lastRequest + COOLDOWN) {
            revert CooldownActive(lastRequest + COOLDOWN);
        }
        lastRequest = block.timestamp;
        TOKEN.mint(recipient, DRIP);
    }
}
