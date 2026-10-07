// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title ReentrantSigner1271: ERC-1271 payee that tries to change PayLink state from `isValidSignature`
/// @notice Before answering, it calls `target` with `data` (for example `PayLinkV2.cancel(inv)` with itself as
///         payee, or a second payment). It always answers the magic value, so the outer payment proceeds and the
///         test can check that the nested state change did not happen. Not declared `view`, so the compiler does
///         not stop the attempt; the EVM does (OpenZeppelin `SignatureChecker` uses STATICCALL).
/// @dev Audit PoC mock (test-only).
contract ReentrantSigner1271 {
    address public target;
    bytes public data;

    receive() external payable {}

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function isValidSignature(bytes32, bytes calldata) external returns (bytes4) {
        if (target != address(0)) {
            // forge-lint: disable-next-line(unchecked-call)
            (bool ok,) = target.call(data);
            ok; // the outcome is observed through PayLink's state, not here
        }
        return IERC1271.isValidSignature.selector;
    }
}

/// @title PermissiveFallbackToken: WETH9-like token without `permit` whose fallback succeeds on any call
/// @notice The classic "phantom permit" shape: `permit(...)` hits the fallback and returns successfully without
///         setting an allowance. Balances and allowances are standard.
/// @dev Audit PoC mock (test-only).
contract PermissiveFallbackToken {
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    fallback() external payable {}

    receive() external payable {}

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

/// @title NoReturnToken: USDT-style token whose `transfer`/`transferFrom` return nothing
/// @notice `failQuietly` makes both return `false` (ABI-encoded) instead of reverting, like some legacy tokens.
/// @dev Audit PoC mock (test-only).
contract NoReturnToken {
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    bool public failQuietly;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function setFailQuietly(bool fail) external {
        failQuietly = fail;
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
    }

    function transfer(address to, uint256 value) external {
        if (failQuietly) _returnFalse();
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        if (failQuietly) _returnFalse();
        require(allowance[from][msg.sender] >= value, "allowance");
        allowance[from][msg.sender] -= value;
        _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function _returnFalse() private pure {
        assembly ("memory-safe") {
            mstore(0, 0)
            return(0, 32)
        }
    }
}
