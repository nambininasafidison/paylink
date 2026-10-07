// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockPermit: MUSD-like test token (18 decimals, EIP-2612 only, no EIP-3009)
/// @notice OpenZeppelin's ERC20Permit (EIP-712 version "1"). Paid through `pay` or `payWithPermit`.
/// @dev Test-only: `mint` is unrestricted.
contract MockPermit is ERC20Permit {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC20Permit(name_) {}

    /// @notice Test faucet.
    function mint(address to, uint256 value) external {
        _mint(to, value);
    }
}
