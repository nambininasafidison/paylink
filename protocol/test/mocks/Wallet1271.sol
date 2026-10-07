// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Wallet1271: minimal deployed smart account (ERC-1271)
/// @notice Accepts a hash when it carries a valid ECDSA signature of `owner`, or, with an empty signature, when the
///         owner pre-approved it (Safe-style). The owner can rotate itself, which revokes every earlier signature:
///         PayLinkV2 re-verifies the payee on every payment.
/// @dev Test-only.
contract Wallet1271 is IERC1271 {
    bytes4 internal constant MAGIC = IERC1271.isValidSignature.selector;

    address public owner;
    mapping(bytes32 hash => bool) public approvedHashes;

    error NotOwner();

    constructor(address owner_) {
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    receive() external payable {}

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function approveHash(bytes32 hash, bool approved) external onlyOwner {
        approvedHashes[hash] = approved;
    }

    /// @notice Makes a call as the wallet (e.g. `PayLinkV2.cancel` with the wallet as `msg.sender`).
    function execute(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length == 0) return approvedHashes[hash] ? MAGIC : bytes4(0xffffffff);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == owner ? MAGIC : bytes4(0xffffffff);
    }
}
