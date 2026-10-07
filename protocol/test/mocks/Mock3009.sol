// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IERC3009} from "../../src/interfaces/IERC3009.sol";

/// @title Mock3009: USDC/AUSD-like test token (EIP-3009 + EIP-2612)
/// @notice Mirrors the observable behaviour of Circle's FiatToken v2.2 for the v,r,s forms: strict time bounds
///         (`validAfter < now < validBefore`), random nonces used once per authorizer, `to == msg.sender` for
///         `receiveWithAuthorization`, low-s ECDSA only, and FiatToken's revert strings, so the SDK error decoder
///         can be tested against realistic failures. The EIP-712 version is a constructor argument (USDC uses "2").
/// @dev Test-only: `mint` is unrestricted.
contract Mock3009 is ERC20, EIP712, Nonces, IERC20Permit, IERC3009 {
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    uint8 private immutable _decimals;
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) private _authorizationStates;

    constructor(string memory name_, string memory symbol_, string memory version_, uint8 decimals_)
        ERC20(name_, symbol_)
        EIP712(name_, version_)
    {
        _decimals = decimals_;
    }

    /// @notice Test faucet.
    function mint(address to, uint256 value) external {
        _mint(to, value);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ------------------------------------------------------------------ EIP-2612

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        public
        virtual
    {
        require(block.timestamp <= deadline, "FiatTokenV2: permit is expired");
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline)));
        require(_isSigner(digest, v, r, s, owner), "EIP2612: invalid signature");
        _approve(owner, spender, value);
    }

    function nonces(address owner) public view override(IERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ EIP-3009

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

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
    ) external {
        _useAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
        _transfer(from, to, value);
    }

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
    ) external {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        _useAuthorization(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s);
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(!_authorizationStates[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        require(_isSigner(digest, v, r, s, authorizer), "FiatTokenV2: invalid signature");
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    // ------------------------------------------------------------------ internals

    function _useAuthorization(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!_authorizationStates[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce)));
        require(_isSigner(digest, v, r, s, from), "FiatTokenV2: invalid signature");
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    /// @dev Like FiatToken's ECRecover: high-s and malformed signatures never match, nor does the zero address.
    function _isSigner(bytes32 digest, uint8 v, bytes32 r, bytes32 s, address expected) private pure returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
        return err == ECDSA.RecoverError.NoError && recovered == expected && expected != address(0);
    }
}
