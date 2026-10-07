// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title RevertingPayee: ERC-1271 payee that refuses native coin
/// @notice Accepts every signature, so payments reach the transfer step, then makes `receive` fail: with a custom
///         error, with empty revert data, or by re-entering a target (PayLinkV2) and bubbling the result.
/// @dev Test-only. Shows that `payNative` reverts atomically and bubbles the payee's reason.
contract RevertingPayee is IERC1271 {
    enum Mode {
        RevertWithError,
        RevertEmpty,
        Reenter
    }

    error PayeeRejected();

    Mode public mode;
    address public reentryTarget;
    bytes public reentryData;

    constructor(Mode mode_) {
        mode = mode_;
    }

    function setReentry(address target, bytes calldata data) external {
        mode = Mode.Reenter;
        reentryTarget = target;
        reentryData = data;
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return IERC1271.isValidSignature.selector;
    }

    receive() external payable {
        if (mode == Mode.RevertWithError) revert PayeeRejected();
        if (mode == Mode.RevertEmpty) revert();
        (bool ok, bytes memory ret) = reentryTarget.call(reentryData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
