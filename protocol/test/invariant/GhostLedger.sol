// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";

/// @dev `Entry.payeeActor` value for the ERC-1271 wallet payee (owned by actor 0).
uint256 constant WALLET_PAYEE = type(uint256).max;

/// @title GhostLedger: the invariant suite's independent record of what happened
/// @notice Written only by the Handler. It holds:
///         - the invoices the handler created and the model's expected state for each key;
///         - what the contract emitted (`Paid` count and sum per key), decoded from the logs, so I3 compares storage
///           with events rather than with the handler's own bookkeeping;
///         - the stray balances donated to PayLink (I1's absolute form);
///         - a violation counter and last reason per invariant ID (I1..I11) and for model/contract disagreement.
/// @dev Invariant functions assert the counters are zero, so a failure is reported under the invariant's own name
///      together with the first offending call's description.
contract GhostLedger {
    /// @notice Kind of asset an invoice is denominated in.
    enum Asset {
        Usdc3009, // Mock3009: EIP-3009 + EIP-2612, 6 decimals
        MusdPermit, // MockPermit: EIP-2612 only, 18 decimals
        FeeToken, // FeeOnTransfer: EIP-3009 + EIP-2612, 1% fee deducted from the amount on every leg
        Native,
        ForwardFee, // FeeOnTransfer with PayLink exempt as a recipient: the 1% fee hits only the forward leg (mode
        // switched by Handler.reconfigureFee: deducted from the payee's credit, or charged to the sender on top)
        OverCredit // OverCreditToken: EIP-3009 + EIP-2612, 6 decimals; standard until Handler.reconfigureOverCredit
        // arms one leg to move more than the amount (PayLink or the payee credited extra, or PayLink debited less)
    }

    struct Entry {
        IPayLinkV2.Invoice inv;
        bytes sig;
        bytes32 key;
        Asset asset;
        uint256 payeeActor; // index into the handler's actors, or WALLET_PAYEE
    }

    /// @notice Expected state of one key according to the handler's model.
    struct Model {
        uint32 payments;
        bool cancelled;
        uint64 lastPaidAt;
        uint128 total;
    }

    address public immutable handler;

    Entry[] internal _entries;
    mapping(bytes32 key => uint256 indexPlusOne) public entryIndexOf;
    mapping(bytes32 key => Model) internal _model;
    mapping(bytes32 key => IPayLinkV2.LinkState) internal _lastSeen;

    mapping(bytes32 key => uint256) public paidEvents;
    mapping(bytes32 key => uint256) public paidSum;
    mapping(bytes32 key => bool) public cancelEventSeen;

    mapping(address token => uint256) public donated; // address(0) = native

    uint256[12] public violations; // [0] = model mismatch, [1..11] = I1..I11
    string[12] internal _firstViolation;

    mapping(bytes32 action => uint256) public calls;
    bytes32[] internal _actionNames;

    mapping(bytes32 outcomeId => uint256) internal _outcomes;
    string[] internal _outcomeNames;

    error OnlyHandler();

    constructor() {
        handler = msg.sender;
    }

    modifier onlyHandler() {
        if (msg.sender != handler) revert OnlyHandler();
        _;
    }

    // ------------------------------------------------------------------ writes (handler only)

    function addEntry(Entry calldata e) external onlyHandler {
        _entries.push(e);
        entryIndexOf[e.key] = _entries.length;
    }

    function setModel(bytes32 key, Model calldata m) external onlyHandler {
        _model[key] = m;
    }

    function setLastSeen(bytes32 key, IPayLinkV2.LinkState calldata st) external onlyHandler {
        _lastSeen[key] = st;
    }

    function recordPaid(bytes32 key, uint256 amount) external onlyHandler {
        ++paidEvents[key];
        paidSum[key] += amount;
    }

    function recordCancelEvent(bytes32 key) external onlyHandler {
        cancelEventSeen[key] = true;
    }

    function recordDonation(address token, uint256 amount) external onlyHandler {
        donated[token] += amount;
    }

    function recordViolation(uint8 id, string calldata reason) external onlyHandler {
        if (violations[id] == 0) _firstViolation[id] = reason;
        ++violations[id];
    }

    function countCall(bytes32 action) external onlyHandler {
        if (calls[action] == 0) _actionNames.push(action);
        ++calls[action];
    }

    /// @notice Counts one contract call outcome, e.g. "pay -> ok" or "pay -> SoldOut".
    function countOutcome(string calldata outcome) external onlyHandler {
        bytes32 id = keccak256(bytes(outcome));
        if (_outcomes[id] == 0) _outcomeNames.push(outcome);
        ++_outcomes[id];
    }

    // ------------------------------------------------------------------ reads

    function entryCount() external view returns (uint256) {
        return _entries.length;
    }

    function entry(uint256 i) external view returns (Entry memory) {
        return _entries[i];
    }

    function keyAt(uint256 i) external view returns (bytes32) {
        return _entries[i].key;
    }

    function invoiceAt(uint256 i) external view returns (IPayLinkV2.Invoice memory) {
        return _entries[i].inv;
    }

    function model(bytes32 key) external view returns (Model memory) {
        return _model[key];
    }

    function lastSeen(bytes32 key) external view returns (IPayLinkV2.LinkState memory) {
        return _lastSeen[key];
    }

    function firstViolation(uint8 id) external view returns (string memory) {
        return _firstViolation[id];
    }

    function actionNames() external view returns (bytes32[] memory) {
        return _actionNames;
    }

    function outcomeNames() external view returns (string[] memory) {
        return _outcomeNames;
    }

    function outcomeCount(string calldata outcome) external view returns (uint256) {
        return _outcomes[keccak256(bytes(outcome))];
    }
}
