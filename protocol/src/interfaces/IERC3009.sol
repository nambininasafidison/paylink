// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IERC3009: transfer with authorization (v, r, s form)
/// @notice The EIP-3009 surface PayLink relies on, as implemented by Circle's FiatToken v2.x (USDC) and AUSD.
/// @dev https://eips.ethereum.org/EIPS/eip-3009. PayLinkV2 only calls `receiveWithAuthorization`, whose
///      `to == msg.sender` rule stops a third party from front-running the transfer to another recipient.
///      The token verifies the authorization against its own EIP-712 domain with the type
///      `ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`.
///      Nonces are random 32-byte values, used at most once per `from` (not sequential).
interface IERC3009 {
    /// @notice An authorization was consumed.
    /// @param authorizer The token holder who signed it.
    /// @param nonce Its nonce.
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    /// @notice An authorization was cancelled before use.
    /// @param authorizer The token holder who signed it.
    /// @param nonce Its nonce.
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    /// @notice Returns whether a nonce has been used or cancelled for `authorizer`.
    /// @param authorizer Token holder.
    /// @param nonce Authorization nonce.
    /// @return True if the nonce can no longer be used.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    /// @notice Executes a transfer signed by `from`; any caller may submit it.
    /// @param from Payer.
    /// @param to Payee.
    /// @param value Amount.
    /// @param validAfter The authorization is valid strictly after this unix time.
    /// @param validBefore The authorization is valid strictly before this unix time.
    /// @param nonce Unique nonce.
    /// @param v ECDSA recovery id.
    /// @param r ECDSA `r`.
    /// @param s ECDSA `s`.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Executes a transfer signed by `from` to the caller; reverts unless `to == msg.sender`.
    /// @param from Payer.
    /// @param to Payee; must be the caller.
    /// @param value Amount.
    /// @param validAfter The authorization is valid strictly after this unix time.
    /// @param validBefore The authorization is valid strictly before this unix time.
    /// @param nonce Unique nonce.
    /// @param v ECDSA recovery id.
    /// @param r ECDSA `r`.
    /// @param s ECDSA `s`.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Cancels an unused authorization, signed by its authorizer.
    /// @param authorizer Token holder.
    /// @param nonce Nonce to cancel.
    /// @param v ECDSA recovery id.
    /// @param r ECDSA `r`.
    /// @param s ECDSA `s`.
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
}
