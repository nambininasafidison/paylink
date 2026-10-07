// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title TxOriginLure: an attacker's contract a victim is lured into calling (SWC-115)
/// @notice `claim()` looks harmless (an "airdrop"), but forwards a call the attacker prepared to PayLinkV2, with the
///         lure as `msg.sender` and the victim as `tx.origin`. PayLinkV2 authorizes by `msg.sender` (the payer of
///         `pay`, `payWithPermit` and `payNative`; the payee of `cancel`) or by a signature (`cancelBySig`,
///         `payWithAuthorization`), never by `tx.origin`, so the forwarded call must fail exactly as it would for any
///         stranger: it cannot cancel the victim's links or spend the victim's allowance.
/// @dev Test-only. Bubbles the target's revert data unchanged, so tests can pin PayLinkV2's own error.
contract TxOriginLure {
    address public immutable target;
    bytes public payload;

    constructor(address target_, bytes memory payload_) {
        target = target_;
        payload = payload_;
    }

    function claim() external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(payload);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
