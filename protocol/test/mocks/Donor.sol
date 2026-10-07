// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Donor: makes stray transfers to PayLinkV2
/// @notice Plain ERC-20 transfers to the contract (accepted: tokens cannot refuse them) and plain native transfers
///         (refused by `receive` with `WrongPaymentPath`). Forced native balance (SELFDESTRUCT, coinbase) is
///         simulated in tests with `vm.deal`, because solc 0.8.30 warns on `selfdestruct` and warnings fail the
///         build. Spec §3.3.3: donations must never brick the contract.
/// @dev Test-only.
contract Donor {
    using SafeERC20 for IERC20;

    function donate(IERC20 token, address to, uint256 value) external {
        token.safeTransfer(to, value);
    }

    function tryDonateNative(address to) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call{value: msg.value}("");
    }
}
