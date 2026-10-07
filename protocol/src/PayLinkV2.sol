// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IERC3009} from "./interfaces/IERC3009.sol";
import {IPayLinkV2} from "./interfaces/IPayLinkV2.sol";

/// @title PayLinkV2: signed, non-custodial payment links
/// @author PayLink (github.com/nambininasafidison/paylink)
/// @notice Settles EIP-712 invoices signed off-chain by their payee. Immutable, ownerless and fee-less: no proxy,
///         admin, pause, sweep or upgrade. Incident response is a redeploy; old signatures then stop verifying,
///         because `verifyingContract` is part of the EIP-712 domain.
/// @dev Design and invariants: PAYLINK-V2-SPEC §3.3 and protocol/audit/invariants.md.
///      - Every settlement runs the same skeleton (§3.3.3): shape and path checks, one SLOAD of the link state,
///        the remaining checks, then effects (one SSTORE, `Paid`), then interactions.
///      - The payee signature is verified on every payment (ECDSA for code-less payees, ERC-1271 otherwise), so
///        a contract payee can revoke by changing what it accepts.
///      - Exact-delta settlement: amounts received and credited are measured, so fee-on-transfer tokens revert.
///      - Relative conservation: PayLink's balance after a call equals its balance before. It is never required
///        to be zero, so a stray donation cannot brick the contract; donations stay inert, as nothing can move
///        them out.
///      - Unsupported by design: rebasing tokens, tokens that charge the sender on top of the amount, and
///        EIP-7702-delegated payees whose delegate does not implement ERC-1271. Front ends only offer tokens from
///        each chain's registry allowlist.
/// @custom:security-contact https://github.com/nambininasafidison/paylink/security/advisories/new
contract PayLinkV2 is IPayLinkV2, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice EIP-712 type hash of `Invoice`; the struct hash of an invoice is its link id's preimage.
    bytes32 public constant INVOICE_TYPEHASH = keccak256(
        "Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)"
    );

    /// @notice EIP-712 type hash of the payee's gasless revocation, `Cancel(bytes32 key,uint256 deadline)`.
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 key,uint256 deadline)");

    /// @notice Type hash that binds an EIP-3009 token nonce to one payment (see `paymentNonce`).
    bytes32 public constant PAYMENT_BINDING_TYPEHASH =
        keccak256("PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)");

    /// @dev Largest batch `statesOf` accepts; bounds the memory and gas of a single read.
    uint256 private constant MAX_BATCH = 256;

    /// @dev One packed slot per link (232 bits), written lazily on its first payment or cancellation.
    mapping(bytes32 key => LinkState state) private _states;

    /// @notice Deploys the contract. Takes no argument, so the init code (and its hash) is identical on every
    ///         chain; only the EIP-712 immutables (chainId, address, domain separator) differ at runtime.
    constructor() EIP712("PayLink", "2") {}

    /// @notice Rejects plain native transfers: native invoices are paid through `payNative`.
    receive() external payable {
        revert WrongPaymentPath();
    }

    /// @notice Rejects calls to unknown functions, with or without value.
    fallback() external payable {
        revert WrongPaymentPath();
    }

    // ------------------------------------------------------------------ settlement

    /// @inheritdoc IPayLinkV2
    function payWithAuthorization(Invoice calldata inv, bytes calldata payeeSig, Authorization calldata auth)
        external
        nonReentrant
        returns (uint32 index)
    {
        bytes32 key;
        (key, index) = _record(inv, payeeSig, false, auth.payer, auth.amount, auth.payerRef);
        _receiveAndForward(IERC20(inv.token), inv.payee, key, auth);
    }

    /// @inheritdoc IPayLinkV2
    function pay(Invoice calldata inv, bytes calldata payeeSig, uint128 amount, bytes32 payerRef)
        external
        nonReentrant
        returns (uint32 index)
    {
        (, index) = _record(inv, payeeSig, false, msg.sender, amount, payerRef);
        _pullExact(IERC20(inv.token), msg.sender, inv.payee, amount);
    }

    /// @inheritdoc IPayLinkV2
    function payWithPermit(
        Invoice calldata inv,
        bytes calldata payeeSig,
        uint128 amount,
        bytes32 payerRef,
        Permit calldata p
    ) external nonReentrant returns (uint32 index) {
        (, index) = _record(inv, payeeSig, false, msg.sender, amount, payerRef);

        // The permit is an interaction, so it runs after the effects. Its failure is ignored on purpose: if a
        // third party front-ran it, the allowance already exists; otherwise `transferFrom` reverts below.
        try IERC20Permit(inv.token).permit(msg.sender, address(this), amount, p.deadline, p.v, p.r, p.s) {} catch {}

        _pullExact(IERC20(inv.token), msg.sender, inv.payee, amount);
    }

    /// @inheritdoc IPayLinkV2
    function payNative(Invoice calldata inv, bytes calldata payeeSig, bytes32 payerRef)
        external
        payable
        nonReentrant
        returns (uint32 index)
    {
        // Unreachable on production chains (2^128 wei); keeps the uint128 accounting exact.
        if (msg.value > type(uint128).max) revert WrongAmount(inv.amount, type(uint128).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        (, index) = _record(inv, payeeSig, true, msg.sender, uint128(msg.value), payerRef);
        // The destination is the payee whose signature `_record` just verified, and the value is the caller's own.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        Address.sendValue(payable(inv.payee), msg.value);
    }

    // ------------------------------------------------------------------ revocation

    /// @inheritdoc IPayLinkV2
    function cancel(Invoice calldata inv) external nonReentrant {
        _checkShape(inv);
        if (msg.sender != inv.payee) revert NotPayee();
        bytes32 key = _invoiceKey(inv);
        LinkState storage st = _states[key];
        if (st.cancelled) revert Cancelled();
        _markCancelled(st, key, inv.payee);
    }

    /// @inheritdoc IPayLinkV2
    function cancelBySig(Invoice calldata inv, uint256 deadline, bytes calldata payeeSig) external nonReentrant {
        _checkShape(inv);
        // Second-level timestamp drift is irrelevant to a revocation deadline (audit/triage.md, S-2).
        // forge-lint: disable-start(block-timestamp)
        // slither-disable-next-line timestamp
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        // forge-lint: disable-end(block-timestamp)
        bytes32 key = _invoiceKey(inv);
        LinkState storage st = _states[key];
        if (st.cancelled) revert Cancelled();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, key, deadline)));
        if (!SignatureChecker.isValidSignatureNow(inv.payee, digest, payeeSig)) revert InvalidSignature();
        _markCancelled(st, key, inv.payee);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IPayLinkV2
    function invoiceKey(Invoice calldata inv) external view returns (bytes32) {
        return _invoiceKey(inv);
    }

    /// @inheritdoc IPayLinkV2
    function paymentNonce(bytes32 key, address payer, uint128 amount, bytes32 payerRef, bytes32 payerSalt)
        external
        pure
        returns (bytes32)
    {
        return _paymentNonce(key, payer, amount, payerRef, payerSalt);
    }

    /// @inheritdoc IPayLinkV2
    function stateOf(bytes32 key) external view returns (LinkState memory) {
        return _states[key];
    }

    /// @inheritdoc IPayLinkV2
    function statesOf(bytes32[] calldata keys) external view returns (LinkState[] memory states) {
        uint256 n = keys.length;
        if (n > MAX_BATCH) revert BatchTooLarge(MAX_BATCH);
        states = new LinkState[](n);
        for (uint256 i = 0; i < n; ++i) {
            states[i] = _states[keys[i]];
        }
    }

    // ------------------------------------------------------------------ internals

    /// @dev Checks and effects shared by every settlement path (spec §3.3.3 steps 1-4). Interactions are left to
    ///      the caller, after this returns. `native` selects the path the caller implements; `payer` is the
    ///      account debited.
    function _record(
        Invoice calldata inv,
        bytes calldata payeeSig,
        bool native,
        address payer,
        uint128 amount,
        bytes32 payerRef
    ) private returns (bytes32 key, uint32 index) {
        _checkShape(inv);
        if ((inv.token == address(0)) != native) revert WrongPaymentPath();

        key = _invoiceKey(inv);
        LinkState memory st = _states[key];

        if (st.cancelled) revert Cancelled();
        if (!SignatureChecker.isValidSignatureNow(inv.payee, key, payeeSig)) revert InvalidSignature();
        // The payment window is a business rule at second granularity; producer timestamp drift is irrelevant
        // (audit/triage.md, S-2).
        // forge-lint: disable-start(block-timestamp)
        // slither-disable-next-line timestamp
        if (block.timestamp < inv.validAfter) revert NotYetValid(inv.validAfter);
        if (inv.validUntil != 0 && block.timestamp > inv.validUntil) revert Expired(inv.validUntil);
        // forge-lint: disable-end(block-timestamp)
        if (inv.maxPayments != 0 && st.payments >= inv.maxPayments) revert SoldOut(inv.maxPayments);
        if (inv.amount == 0 ? amount == 0 : amount != inv.amount) revert WrongAmount(inv.amount, amount);
        if (payer == inv.payee) revert SelfPayment();

        // Checked arithmetic: a link stops accepting payments rather than wrap `payments` (2^32) or `total`
        // (2^128 base units).
        index = st.payments;
        st.payments = index + 1;
        st.total += amount;
        // forge-lint: disable-next-line(unsafe-typecast)
        st.lastPaidAt = uint64(block.timestamp);
        _states[key] = st;

        // The only earlier external call is the ERC-1271 STATICCALL in the signature check, which cannot reenter;
        // every token or value transfer happens after this event.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Paid(key, inv.payee, payer, inv.token, amount, index, payerRef);
    }

    /// @dev Writes the cancelled flag and emits the event. The caller has checked authorization and that the link
    ///      is not already cancelled.
    function _markCancelled(LinkState storage st, bytes32 key, address payee) private {
        st.cancelled = true;
        // The only earlier external call is the ERC-1271 STATICCALL of `cancelBySig`, which cannot reenter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit InvoiceCancelled(key, payee);
    }

    /// @dev EIP-3009 interaction (spec §3.3.3 step 5): pulls `auth.amount` from the payer with the bound nonce,
    ///      checks exactly that amount arrived, forwards it to the payee with the payee-delta check, and checks
    ///      PayLink's balance is back where it started.
    function _receiveAndForward(IERC20 token, address payee, bytes32 key, Authorization calldata auth) private {
        bytes32 nonce = _paymentNonce(key, auth.payer, auth.amount, auth.payerRef, auth.payerSalt);
        // The balance is read before the token call on purpose: the deltas below are the exact-receipt and
        // conservation checks, and every entry point is nonReentrant (audit/triage.md, S-1).
        // slither-disable-next-line reentrancy-balance
        uint256 balanceBefore = token.balanceOf(address(this));
        IERC3009(address(token))
            .receiveWithAuthorization(
                auth.payer, address(this), auth.amount, auth.validAfter, auth.validBefore, nonce, auth.v, auth.r, auth.s
            );
        uint256 received = _increase(balanceBefore, token.balanceOf(address(this)));
        if (received != auth.amount) revert ReceivedMismatch(auth.amount, received);

        _pushExact(token, payee, auth.amount);

        // Conservation post-check (invariant I1): the pass-through left PayLink's balance unchanged. This also
        // stops a token that debits the sender beyond `amount` from spending stray donations.
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter != balanceBefore) revert ReceivedMismatch(balanceBefore, balanceAfter);
    }

    /// @dev Moves `amount` from `from` straight to `payee` (funds never touch PayLink) and checks the payee's
    ///      balance rose by exactly `amount`.
    function _pullExact(IERC20 token, address from, address payee, uint256 amount) private {
        uint256 balanceBefore = token.balanceOf(payee);
        token.safeTransferFrom(from, payee, amount);
        uint256 credited = _increase(balanceBefore, token.balanceOf(payee));
        if (credited != amount) revert PayeeShortPaid(amount, credited);
    }

    /// @dev Forwards `amount` held transiently by PayLink to `payee` and checks the payee's balance rose by exactly
    ///      `amount`.
    function _pushExact(IERC20 token, address payee, uint256 amount) private {
        uint256 balanceBefore = token.balanceOf(payee);
        token.safeTransfer(payee, amount);
        uint256 credited = _increase(balanceBefore, token.balanceOf(payee));
        if (credited != amount) revert PayeeShortPaid(amount, credited);
    }

    /// @dev Reverts `InvalidInvoice` on a malformed invoice (spec §3.3.3 step 1).
    function _checkShape(Invoice calldata inv) private view {
        if (inv.payee == address(0) || inv.payee == address(this) || inv.token == address(this)) {
            revert InvalidInvoice();
        }
        if (inv.validUntil != 0 && inv.validUntil < inv.validAfter) revert InvalidInvoice();
    }

    /// @dev EIP-712 digest of `inv` under this deployment's domain: the link id.
    function _invoiceKey(Invoice calldata inv) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    INVOICE_TYPEHASH,
                    inv.payee,
                    inv.token,
                    inv.amount,
                    inv.validAfter,
                    inv.validUntil,
                    inv.maxPayments,
                    inv.salt,
                    inv.memoHash
                )
            )
        );
    }

    /// @dev EIP-3009 nonce bound to one payment. `key` already commits to chainId and verifyingContract.
    function _paymentNonce(bytes32 key, address payer, uint128 amount, bytes32 payerRef, bytes32 payerSalt)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payer, amount, payerRef, payerSalt));
    }

    /// @dev Increase from `before` to `afterwards`, or 0 if the balance did not increase.
    function _increase(uint256 before, uint256 afterwards) private pure returns (uint256) {
        return afterwards > before ? afterwards - before : 0;
    }
}
