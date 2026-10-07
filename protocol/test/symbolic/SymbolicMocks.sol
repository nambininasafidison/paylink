// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title SymbolicToken: honest-balance ERC-20 + EIP-3009 receive whose transfers move arbitrary amounts
/// @notice For the Halmos suite (`PayLinkSymbolic.t.sol`). `balanceOf` always reports the stored balance, but each
///         transfer debits the sender and credits the recipient by `value` adjusted up or down by a per-leg amount
///         set once by the test from symbolic inputs:
///         - leg 0, receive: the recipient is PayLink (EIP-3009 `receiveWithAuthorization`);
///         - leg 1, push: the sender is PayLink (its forwarding `transfer`);
///         - leg 2, pull: neither (`transferFrom` payer -> payee).
///         Fee-on-transfer, charge-the-sender, over-crediting, rebating and balance-reversing tokens are all points
///         of this space, so a property proved over it holds for every token whose `balanceOf` tells the truth.
/// @dev Test-only. No signature check (`receiveWithAuthorization` only requires `to == msg.sender`, as EIP-3009
///      does): the Halmos suite is about conservation and the state machine, never about signatures. Underflows
///      revert (checked arithmetic), like a real token refusing a transfer.
contract SymbolicToken {
    struct Skew {
        uint256 creditDelta;
        bool creditUp;
        uint256 debitDelta;
        bool debitUp;
    }

    address public immutable payLink;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    Skew[3] internal _skews;

    constructor(address payLink_) {
        payLink = payLink_;
    }

    function setSkew(uint8 leg, uint256 creditDelta, bool creditUp, uint256 debitDelta, bool debitUp) external {
        _skews[leg] = Skew(creditDelta, creditUp, debitDelta, debitUp);
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

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32,
        uint8,
        bytes32,
        bytes32
    ) external {
        require(to == msg.sender, "SymbolicToken: caller must be the payee");
        _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) internal {
        Skew memory k = _skews[to == payLink ? 0 : from == payLink ? 1 : 2];
        uint256 debit = k.debitUp ? value + k.debitDelta : value - k.debitDelta;
        uint256 credit = k.creditUp ? value + k.creditDelta : value - k.creditDelta;
        balanceOf[from] -= debit;
        balanceOf[to] += credit;
    }
}

/// @title AcceptAll1271: a deployed payee whose ERC-1271 check accepts every hash
/// @notice The Halmos suite stubs the payee signature this way: `SignatureChecker` dispatches to ERC-1271 for payees
///         with code, so no ECDSA is executed symbolically. It can also call PayLink (to `cancel` as the payee).
/// @dev Test-only.
contract AcceptAll1271 is IERC1271 {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return IERC1271.isValidSignature.selector;
    }

    /// @notice Calls `target` as this payee (e.g. `PayLinkV2.cancel`) and reports the outcome without reverting.
    function execute(address target, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call(data);
    }

    receive() external payable {}
}
