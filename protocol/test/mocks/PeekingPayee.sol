// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";

/// @title PeekingPayee: an ERC-1271 payee that reads PayLink's link state while it is being paid
/// @notice Accepts a hash carrying a valid ECDSA signature of `owner` (like Wallet1271). Its `receive` performs a
///         read-only re-entry: it calls `stateOf(watched)` on the PayLink contract that is paying it and records the
///         answer, as an integrator or an accounting hook in a payee wallet would. Under checks-effects-interactions
///         (spec §3.3.3) the payment is already recorded when the coin arrives; a contract that deferred its storage
///         write past the transfer would show the payee the pre-payment state.
/// @dev Test-only.
contract PeekingPayee is IERC1271 {
    IPayLinkV2 public immutable payLink;
    address public immutable owner;
    bytes32 public watched;
    IPayLinkV2.LinkState public seen;
    uint256 public peeks;

    constructor(IPayLinkV2 payLink_, address owner_) {
        payLink = payLink_;
        owner = owner_;
    }

    function watch(bytes32 key) external {
        watched = key;
    }

    receive() external payable {
        seen = payLink.stateOf(watched);
        ++peeks;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == owner
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }
}
