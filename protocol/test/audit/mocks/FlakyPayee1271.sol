// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title FlakyPayee1271: ERC-1271 payee whose answer differs between a relayer's simulation and inclusion
/// @notice Accepts its owner's ECDSA signature, but only while "open":
///         - `Toggle`: open until the owner flips `refusing` (one SSTORE that affects every pending relay);
///         - `EvenBlocks`: open on even block numbers only (no transaction at all: a simulation at block N and an
///           inclusion at N + 1 disagree).
///         A relayer that simulates with `eth_call` and then sends sees success, then a revert it pays for.
/// @dev Audit PoC mock (test-only).
contract FlakyPayee1271 is IERC1271 {
    enum Mode {
        Toggle,
        EvenBlocks
    }

    address public immutable owner;
    Mode public immutable mode;
    bool public refusing;

    error NotOwner();

    constructor(address owner_, Mode mode_) {
        owner = owner_;
        mode = mode_;
    }

    function setRefusing(bool refusing_) external {
        if (msg.sender != owner) revert NotOwner();
        refusing = refusing_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        bool open = mode == Mode.Toggle ? !refusing : block.number % 2 == 0;
        if (!open) return 0xffffffff;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == owner
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }
}
