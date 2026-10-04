// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PayLink — shareable USDC payment links on Arc
/// @notice On Arc, USDC is the native gas token, so payments are plain
///         `msg.value` transfers (18-decimal native units). Funds are never
///         held by this contract: every payment is forwarded to the payee
///         in the same transaction.
/// @dev Two kinds of links:
///      - fixed amount (an invoice): one exact payment, then the link closes;
///      - open amount (amount == 0): a reusable tip jar / donation link.
contract PayLink {
    struct Link {
        address payee;
        uint128 amount; // native units (18 decimals); 0 = payer chooses
        uint64 expiresAt; // unix seconds; 0 = never
        bool active;
        uint128 totalReceived;
        uint32 payments;
        string memo;
    }

    uint256 public constant MAX_MEMO_BYTES = 280;

    uint256 public nextId = 1;
    mapping(uint256 => Link) private _links;
    mapping(address => uint256[]) private _linksOf;
    uint256 private _lock = 1;

    event LinkCreated(uint256 indexed id, address indexed payee, uint256 amount, uint64 expiresAt, string memo);
    event Paid(uint256 indexed id, address indexed payer, address indexed payee, uint256 amount, string note);
    event LinkClosed(uint256 indexed id, bool paid);

    error UnknownLink();
    error Inactive();
    error Expired();
    error WrongAmount(uint256 expected, uint256 sent);
    error NotPayee();
    error MemoTooLong();
    error BadExpiry();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice Create a payment link that pays `msg.sender`.
    function create(uint128 amount, uint64 expiresAt, string calldata memo) external returns (uint256 id) {
        if (bytes(memo).length > MAX_MEMO_BYTES) revert MemoTooLong();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert BadExpiry();
        id = nextId++;
        _links[id] = Link({
            payee: msg.sender,
            amount: amount,
            expiresAt: expiresAt,
            active: true,
            totalReceived: 0,
            payments: 0,
            memo: memo
        });
        _linksOf[msg.sender].push(id);
        emit LinkCreated(id, msg.sender, amount, expiresAt, memo);
    }

    /// @notice Pay a link. Fixed links need the exact amount; open links accept any non-zero amount.
    function pay(uint256 id, string calldata note) external payable nonReentrant {
        Link storage l = _links[id];
        if (l.payee == address(0)) revert UnknownLink();
        if (!l.active) revert Inactive();
        if (l.expiresAt != 0 && block.timestamp > l.expiresAt) revert Expired();
        if (bytes(note).length > MAX_MEMO_BYTES) revert MemoTooLong();
        if (l.amount != 0) {
            if (msg.value != l.amount) revert WrongAmount(l.amount, msg.value);
            l.active = false;
        } else if (msg.value == 0) {
            revert WrongAmount(1, 0);
        }
        l.totalReceived += uint128(msg.value);
        l.payments += 1;

        address payee = l.payee;
        (bool ok,) = payee.call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit Paid(id, msg.sender, payee, msg.value, note);
        if (l.amount != 0) emit LinkClosed(id, true);
    }

    /// @notice The payee can close an active link.
    function cancel(uint256 id) external {
        Link storage l = _links[id];
        if (l.payee == address(0)) revert UnknownLink();
        if (l.payee != msg.sender) revert NotPayee();
        if (!l.active) revert Inactive();
        l.active = false;
        emit LinkClosed(id, false);
    }

    function getLink(uint256 id) external view returns (Link memory) {
        if (_links[id].payee == address(0)) revert UnknownLink();
        return _links[id];
    }

    function linksOf(address payee) external view returns (uint256[] memory) {
        return _linksOf[payee];
    }

    /// @dev Reject stray transfers: this contract never holds funds.
    receive() external payable {
        revert();
    }
}
