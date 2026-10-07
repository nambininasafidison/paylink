// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Rebasing: share-based token whose balances scale with an index (stETH-like)
/// @notice Balances are `shares * index / 1e18`; a transfer of `value` moves `value * 1e18 / index` shares, rounded
///         down, so the recipient can be credited 1 base unit less than `value`. Rebasing tokens are unsupported by
///         PayLinkV2 (spec §3.3.3); its exact-delta checks make such payments revert instead of under-paying.
/// @dev Test-only: `mint` and `rebase` are unrestricted. No permit and no EIP-3009.
contract Rebasing is IERC20 {
    uint256 public constant ONE = 1e18;

    uint256 public index = ONE;
    uint256 public totalShares;
    mapping(address account => uint256) public sharesOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    string public constant name = "Rebasing Token";
    string public constant symbol = "REB";
    uint8 public constant decimals = 6;

    function rebase(uint256 newIndex) external {
        index = newIndex;
    }

    function mint(address to, uint256 value) external {
        uint256 shares = value * ONE / index;
        sharesOf[to] += shares;
        totalShares += shares;
        emit Transfer(address(0), to, value);
    }

    function totalSupply() external view returns (uint256) {
        return totalShares * index / ONE;
    }

    function balanceOf(address account) public view returns (uint256) {
        return sharesOf[account] * index / ONE;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "Rebasing: allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        uint256 shares = value * ONE / index;
        require(sharesOf[from] >= shares, "Rebasing: balance");
        sharesOf[from] -= shares;
        sharesOf[to] += shares;
        emit Transfer(from, to, value);
    }
}
