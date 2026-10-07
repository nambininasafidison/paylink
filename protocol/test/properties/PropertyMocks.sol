// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title PropertyActor: a payer and payee for the Echidna and Medusa campaign
/// @notice Echidna and Medusa share no prank or signing cheatcode with Foundry that both support the same way, so the
///         property contract drives PayLinkV2 through actor contracts instead of pranked EOAs:
///         - as a payee it is a deployed ERC-1271 account that accepts exactly the digests it approved (its invoices'
///           link ids and the cancellations it signs), so PayLinkV2's payee signature check runs for real;
///         - as a payer it calls PayLinkV2 and the tokens itself (`msg.sender` is the actor), and pre-approves its
///           EIP-3009 authorizations on `PropertyToken`.
/// @dev Test-only. Only the property contract that deployed it can drive it.
contract PropertyActor is IERC1271 {
    address public immutable owner;
    mapping(bytes32 digest => bool) public approved;

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function approve(bytes32 digest) external {
        if (msg.sender != owner) revert NotOwner();
        approved[digest] = true;
    }

    /// @notice Calls `target` as this actor and reports the outcome without reverting.
    function execute(address target, uint256 value, bytes calldata data) external returns (bool ok, bytes memory ret) {
        if (msg.sender != owner) revert NotOwner();
        (ok, ret) = target.call{value: value}(data);
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return approved[digest] ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

/// @title PropertyToken: ERC-20 with EIP-3009 `receiveWithAuthorization` by pre-approval, and optional skewed legs
/// @notice The EIP-3009 authorization is the payer's on-chain approval of the exact tuple (to, value, validAfter,
///         validBefore, nonce) instead of an ECDSA signature; everything else follows FiatToken: `to` must be the
///         caller, strict time bounds, one use per (authorizer, nonce). PayLinkV2 recomputes the nonce from the
///         payment, so a relayer that changes the link, payer, amount, reference or salt hits an unapproved tuple
///         (invariant I8).
///         `skewCredit` and `skewDebit` reconfigure one side of one leg (0 = receive: the recipient is PayLink;
///         1 = push: the sender is PayLink; 2 = pull: neither) to move `value` plus or minus a delta, the other side
///         unchanged: fee-on-transfer (credit down), charge-the-sender (debit up), over-credit (credit up) and rebate
///         (debit down) are each one call away, and they combine.
/// @dev Test-only: `mint` and `skew` are unrestricted; underflows revert like a refused transfer.
contract PropertyToken {
    struct Skew {
        uint256 creditDelta;
        bool creditUp;
        uint256 debitDelta;
        bool debitUp;
    }

    address public immutable payLink;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    mapping(address authorizer => mapping(bytes32 tuple => bool)) public authorized;
    mapping(address authorizer => mapping(bytes32 nonce => bool)) public authorizationState;
    Skew[3] internal _skews;

    constructor(address payLink_) {
        payLink = payLink_;
    }

    /// @notice Skews what one leg credits to the recipient (`value` plus or minus `delta`); the debit is unchanged.
    function skewCredit(uint8 leg, uint256 delta, bool up) external {
        (_skews[leg].creditDelta, _skews[leg].creditUp) = (delta, up);
    }

    /// @notice Skews what one leg debits from the sender (`value` plus or minus `delta`); the credit is unchanged.
    function skewDebit(uint8 leg, uint256 delta, bool up) external {
        (_skews[leg].debitDelta, _skews[leg].debitUp) = (delta, up);
    }

    /// @notice Makes every leg standard again.
    function resetSkews() external {
        delete _skews;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value;
        _move(from, to, value);
        return true;
    }

    /// @notice The payer's EIP-3009 authorization, given by approving the exact tuple.
    function approveAuthorization(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        external
    {
        authorized[msg.sender][keccak256(abi.encode(to, value, validAfter, validBefore, nonce))] = true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8,
        bytes32,
        bytes32
    ) external {
        require(to == msg.sender, "PropertyToken: caller must be the payee");
        require(block.timestamp > validAfter && block.timestamp < validBefore, "PropertyToken: outside window");
        require(!authorizationState[from][nonce], "PropertyToken: authorization is used");
        require(
            authorized[from][keccak256(abi.encode(to, value, validAfter, validBefore, nonce))],
            "PropertyToken: invalid authorization"
        );
        authorizationState[from][nonce] = true;
        _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) internal {
        Skew memory k = _skews[to == payLink ? 0 : from == payLink ? 1 : 2];
        balanceOf[from] -= k.debitUp ? value + k.debitDelta : value - k.debitDelta;
        balanceOf[to] += k.creditUp ? value + k.creditDelta : value - k.creditDelta;
    }
}
