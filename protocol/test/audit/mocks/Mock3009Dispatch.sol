// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title Mock3009Dispatch: EIP-3009 token with Circle FiatToken v2.2's signature dispatch
/// @notice circlefin/stablecoin-evm `contracts/v2/EIP3009.sol` packs the v,r,s overload as
///         `abi.encodePacked(r, s, v)` and verifies it with `contracts/util/SignatureChecker.sol`, which uses ECDSA
///         when `extcodesize(from) == 0` and ERC-1271 otherwise (source read on 2026-10-07). OpenZeppelin's
///         `SignatureChecker.isValidSignatureNow` has the same dispatch, so this mock reproduces it exactly for the
///         one function PayLinkV2 calls. Unlike `Mock3009` (ECDSA only), an EIP-7702-delegated payer is therefore
///         verified through its delegate's `isValidSignature`.
/// @dev Audit PoC mock (test-only): `mint` is unrestricted; only `receiveWithAuthorization` is implemented.
contract Mock3009Dispatch is ERC20, EIP712 {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    constructor() ERC20("Dispatch USD", "dUSD") EIP712("USDC", "2") {}

    function mint(address to, uint256 value) external {
        _mint(to, value);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
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
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        require(
            SignatureChecker.isValidSignatureNow(from, digest, abi.encodePacked(r, s, v)),
            "FiatTokenV2: invalid signature"
        );
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}
