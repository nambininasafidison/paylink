// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Mock3009} from "./Mock3009.sol";

/// @title HookReentrant: EIP-3009 + EIP-2612 token with an attacker-controlled callback (ERC-777-like)
/// @notice When armed, the token performs one arbitrary call (`target.call(data)`) either after a balance update
///         (`OnTransfer`) or at the start of `permit` (`OnPermit`), then disarms. It records the outcome, and can
///         bubble a failed call's revert data so the outer payment reverts with it.
/// @dev Test-only. Used to show that every PayLinkV2 entry point is guarded (`ReentrancyGuardReentrantCall`), and
///      that a read-only re-entry during an interaction observes the post-effects state.
contract HookReentrant is Mock3009 {
    enum Trigger {
        None,
        OnTransfer,
        OnPermit
    }

    Trigger public trigger;
    address public hookTarget;
    bytes public hookData;
    bool public bubble;

    bool public hookCalled;
    bool public lastHookOk;
    bytes public lastHookReturn;

    constructor() Mock3009("Hook Token", "HOOK", "1", 6) {}

    function arm(Trigger trigger_, address target, bytes calldata data, bool bubble_) external {
        trigger = trigger_;
        hookTarget = target;
        hookData = data;
        bubble = bubble_;
        hookCalled = false;
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        public
        override
    {
        if (trigger == Trigger.OnPermit) _fire();
        super.permit(owner, spender, value, deadline, v, r, s);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (trigger == Trigger.OnTransfer && from != address(0) && to != address(0)) _fire();
    }

    function _fire() private {
        trigger = Trigger.None;
        hookCalled = true;
        (bool ok, bytes memory ret) = hookTarget.call(hookData);
        lastHookOk = ok;
        lastHookReturn = ret;
        if (!ok && bubble) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
