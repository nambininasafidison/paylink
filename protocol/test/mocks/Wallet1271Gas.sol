// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title Wallet1271Gas: hostile ERC-1271 payee
/// @notice Misbehaves in `isValidSignature`: burns all forwarded gas, returns a large payload (return bomb),
///         returns a wrong magic value, returns fewer than 32 bytes, or reverts. Spec §5 threat 13: such a payee can
///         only break payments to itself.
/// @dev Test-only. Accepts native coin, so only the signature check fails.
contract Wallet1271Gas {
    enum Mode {
        BurnAllGas,
        ReturnBomb,
        WrongMagic,
        ShortReturn,
        Revert
    }

    Mode public mode;
    uint256 public bombSize = 100_000;

    constructor(Mode mode_) {
        mode = mode_;
    }

    receive() external payable {}

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function setBombSize(uint256 size) external {
        bombSize = size;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        Mode m = mode;
        if (m == Mode.BurnAllGas) {
            assembly ("memory-safe") {
                invalid()
            }
        }
        if (m == Mode.ReturnBomb) {
            uint256 size = bombSize;
            bytes4 magic = IERC1271.isValidSignature.selector;
            assembly ("memory-safe") {
                mstore(0, magic)
                return(0, size)
            }
        }
        if (m == Mode.ShortReturn) {
            bytes4 magic = IERC1271.isValidSignature.selector;
            assembly ("memory-safe") {
                mstore(0, magic)
                return(0, 4)
            }
        }
        if (m == Mode.Revert) revert("Wallet1271Gas: no");
        return 0xdeadbeef;
    }
}
