// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IPayLinkV2: signed, non-custodial payment links (EIP-712 invoices)
/// @author PayLink (github.com/nambininasafidison/paylink)
/// @notice A payee signs an EIP-712 `Invoice` off-chain; the link id (`key`) is its EIP-712 digest. Anyone holding
///         the invoice and its signature can pay it through one of four settlement paths. There is no on-chain
///         "create": state for a key is written lazily, on its first payment or cancellation.
/// @dev Normative source: PAYLINK-V2-SPEC §3.3. EIP-712 domain `{name: "PayLink", version: "2", chainId,
///      verifyingContract}`, readable through ERC-5267 `eip712Domain()`. The implementation is immutable,
///      ownerless and fee-less, and never holds funds across calls (relative conservation, invariant I1).
///      Every settlement path evaluates the same checks in the same order, so integrators can rely on which
///      error is reported first:
///      `InvalidInvoice`, `WrongPaymentPath`, `Cancelled`, `InvalidSignature`, `NotYetValid`, `Expired`,
///      `SoldOut`, `WrongAmount`, `SelfPayment`, then the token-side checks `ReceivedMismatch` and
///      `PayeeShortPaid`.
interface IPayLinkV2 {
    /// @notice A payment request signed off-chain by `payee`.
    /// @dev EIP-712: Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)
    /// @param payee Receives the funds and signs the invoice: an EOA (ECDSA, low-s only) or a *deployed*
    ///        ERC-1271 account. Counterfactual (undeployed) smart accounts cannot be payees.
    /// @param token ERC-20 token paid, or `address(0)` for the chain's native coin.
    /// @param amount Exact amount in the token's base units, or 0 for an open amount chosen by the payer (> 0).
    /// @param validAfter First second (inclusive, unix time) at which the invoice can be paid.
    /// @param validUntil Last second (inclusive, unix time) at which the invoice can be paid; 0 means no expiry.
    /// @param maxPayments Number of payments accepted: 1 for a one-off invoice, N for N seats, 0 for unlimited.
    /// @param salt 32 random bytes that make each invoice, and therefore each key, unique.
    /// @param memoHash keccak256 of the UTF-8 memo, or 0. The memo itself is never sent on-chain.
    struct Invoice {
        address payee; // receives funds; EOA or *deployed* ERC-1271 account
        address token; // ERC-20; address(0) = native coin (v2 on Arc is T2)
        uint128 amount; // base units; 0 = open amount (payer chooses, > 0)
        uint64 validAfter; // unix seconds, inclusive
        uint64 validUntil; // unix seconds, inclusive; 0 = no expiry (UI requires explicit confirmation)
        uint32 maxPayments; // 1 = one-off invoice; N = N seats; 0 = unlimited (receive card)
        bytes32 salt; // 32 bytes from crypto.getRandomValues
        bytes32 memoHash; // keccak256(utf8(memo)) or 0; the memo itself lives only in the URL fragment
    }

    /// @notice On-chain state of one link.
    /// @dev Exactly one storage slot per key (32+8+64+128 = 232 bits), written lazily on first payment or cancel.
    ///      An unknown key reads as all zeroes.
    /// @param payments Number of settled payments; also the `index` the next payment will receive.
    /// @param cancelled True once the payee has cancelled the link. Never flips back (invariant I11).
    /// @param lastPaidAt `block.timestamp` of the latest payment, or 0 if never paid.
    /// @param total Sum of all settled amounts, in the token's base units.
    struct LinkState {
        uint32 payments;
        bool cancelled;
        uint64 lastPaidAt;
        uint128 total;
    }

    /// @notice EIP-3009 authorization for token.receiveWithAuthorization(payer -> PayLink).
    /// @dev Token nonce MUST equal paymentNonce(key, payer, amount, payerRef, payerSalt), recomputed on-chain.
    ///      The token domain (name, version, chainId, token address) is the token's own, not PayLink's.
    ///      PayLink does not deduplicate across authorizations: on a link with `maxPayments != 1`, two
    ///      authorizations with different salts are two payments. A retry of the same payment therefore resubmits
    ///      the same signed authorization (the token settles at most one copy of a nonce); invoice spec §8.6.
    /// @param payer Token holder who signed the authorization; the `from` of the 3009 transfer.
    /// @param amount Amount authorized and paid, in base units; the 3009 `value`.
    /// @param payerRef Payer-chosen reference echoed in `Paid`. Not unique: receipts are keyed by
    ///        (chainId, txHash, logIndex).
    /// @param validAfter 3009 `validAfter`, enforced by the token.
    /// @param validBefore 3009 `validBefore`, enforced by the token.
    /// @param payerSalt Random value drawn once per intended payment, never for a retry. A new salt is only for a new
    ///        payment, and only once no earlier authorization for the same link and payer is outstanding (cancelled
    ///        on the token, or unused past `validBefore`); invoice spec §8.6.
    /// @param v ECDSA recovery id of the payer's 3009 signature.
    /// @param r ECDSA `r` of the payer's 3009 signature.
    /// @param s ECDSA `s` of the payer's 3009 signature.
    struct Authorization {
        address payer;
        uint128 amount;
        bytes32 payerRef; // payer-chosen reference; NOT unique (receipts key on chainId/txHash/logIndex)
        uint256 validAfter;
        uint256 validBefore;
        bytes32 payerSalt; // random per intended payment; a retry resubmits the same authorization
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice EIP-2612 permit for spender = PayLink, value = amount, owner = msg.sender.
    /// @param deadline EIP-2612 deadline, enforced by the token.
    /// @param v ECDSA recovery id of the owner's permit signature.
    /// @param r ECDSA `r` of the owner's permit signature.
    /// @param s ECDSA `s` of the owner's permit signature.
    struct Permit {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice A payment settled: `amount` of `token` moved from `payer` to `payee`.
    /// @param key EIP-712 digest of the invoice (the link id).
    /// @param payee Recipient, as signed in the invoice.
    /// @param payer Account debited: `msg.sender`, or `auth.payer` for EIP-3009 payments.
    /// @param token ERC-20 token, or `address(0)` for the native coin.
    /// @param amount Amount credited to the payee, in base units.
    /// @param index Zero-based sequence number of this payment within the link.
    /// @param payerRef Payer-chosen reference. Not unique and not authenticated for allowance, permit and
    ///        native payments (the caller sets it); bound into the token nonce for EIP-3009 payments.
    event Paid(
        bytes32 indexed key,
        address indexed payee,
        address indexed payer,
        address token,
        uint128 amount,
        uint32 index,
        bytes32 payerRef
    );

    /// @notice The payee cancelled the link; it accepts no further payment.
    /// @param key EIP-712 digest of the cancelled invoice.
    /// @param payee Payee of the invoice, who authorized the cancellation.
    event InvoiceCancelled(bytes32 indexed key, address indexed payee);

    /// @notice The invoice is malformed: zero payee, PayLink as payee or token, or `validUntil < validAfter`
    ///         with `validUntil != 0`.
    error InvalidInvoice();

    /// @notice The payee's signature (ECDSA or ERC-1271) does not verify against the invoice or cancel digest.
    error InvalidSignature();

    /// @notice The cancel signature's deadline has passed.
    /// @param deadline Last valid second (inclusive) of the signature.
    error SignatureExpired(uint256 deadline);

    /// @notice `cancel` was called by an account other than the invoice's payee.
    error NotPayee();

    /// @notice The link was cancelled by its payee (or is being cancelled a second time).
    error Cancelled();

    /// @notice The invoice cannot be paid before `validAfter`.
    /// @param validAfter First valid second (inclusive).
    error NotYetValid(uint64 validAfter);

    /// @notice The invoice cannot be paid after `validUntil`.
    /// @param validUntil Last valid second (inclusive).
    error Expired(uint64 validUntil);

    /// @notice The link already received `maxPayments` payments.
    /// @param maxPayments Payment cap of the invoice.
    error SoldOut(uint32 maxPayments);

    /// @notice The amount does not match the invoice: not equal to a fixed amount, or zero for an open amount.
    /// @param expected Invoice amount (0 for an open amount).
    /// @param sent Amount offered by the payer (saturated at `type(uint128).max` for native values above it).
    error WrongAmount(uint128 expected, uint128 sent);

    /// @notice The entry point does not match the token kind (native vs ERC-20), or a plain transfer or unknown
    ///         call reached the contract.
    error WrongPaymentPath();

    /// @notice The payer is the payee.
    error SelfPayment();

    /// @notice The token moved a different amount into PayLink than authorized (fee-on-transfer and similar
    ///         tokens), or PayLink's balance changed across the EIP-3009 settlement (conservation post-check).
    /// @param expected Amount PayLink should have received, or its balance before the call for the post-check.
    /// @param received Amount PayLink actually received, or its balance after the call for the post-check.
    error ReceivedMismatch(uint256 expected, uint256 received);

    /// @notice The payee's balance did not increase by exactly the paid amount.
    /// @param expected Amount the payee should have been credited.
    /// @param received Increase of the payee's balance actually observed (0 if it decreased).
    error PayeeShortPaid(uint256 expected, uint256 received);

    /// @notice `statesOf` was called with more keys than allowed.
    /// @param max Largest batch accepted.
    error BatchTooLarge(uint256 max);

    // Settlement: all nonReentrant, checks-effects-interactions, payee signature verified on EVERY payment

    /// @notice Pays an ERC-20 invoice with the payer's EIP-3009 `receiveWithAuthorization`. Anyone may submit
    ///         (typically a relayer): the token nonce binds the authorization to (key, payer, amount, payerRef,
    ///         payerSalt), so a submitter can delay a payment but never redirect it (invariant I8).
    /// @dev The tokens pass through PayLink within the call: received amount and payee credit are both checked
    ///      to equal `auth.amount`, and PayLink's own balance must be unchanged afterwards. The payee's signature
    ///      (ERC-1271 for a payee with code) and the token's check of the payer's signature run at execution, so a
    ///      submitter's earlier simulation does not bind them; relayers bound what they keep in flight (invoice
    ///      spec §13.3).
    /// @param inv Invoice being paid.
    /// @param payeeSig Payee signature over the invoice key (65-byte ECDSA, or ERC-1271 bytes).
    /// @param auth Payer's EIP-3009 authorization.
    /// @return index Zero-based index of this payment within the link.
    function payWithAuthorization(Invoice calldata inv, bytes calldata payeeSig, Authorization calldata auth)
        external
        returns (uint32 index); // anyone may submit (relayer)

    /// @notice Pays an ERC-20 invoice from `msg.sender` using an existing allowance to PayLink.
    /// @dev Tokens move directly from the payer to the payee (`transferFrom`), never through PayLink.
    /// @param inv Invoice being paid.
    /// @param payeeSig Payee signature over the invoice key.
    /// @param amount Amount to pay, in base units (must equal `inv.amount` unless the invoice is open).
    /// @param payerRef Payer-chosen reference echoed in `Paid`.
    /// @return index Zero-based index of this payment within the link.
    function pay(Invoice calldata inv, bytes calldata payeeSig, uint128 amount, bytes32 payerRef)
        external
        returns (uint32 index); // payer = msg.sender (allowance)

    /// @notice Same as `pay`, after trying an EIP-2612 permit (owner = msg.sender, spender = PayLink,
    ///         value = amount).
    /// @dev The permit runs in try/catch after the state is recorded: a permit front-run by a third party is
    ///      harmless, because the allowance it created is then used. A failed permit with an insufficient
    ///      allowance reverts in the token's `transferFrom`.
    /// @param inv Invoice being paid.
    /// @param payeeSig Payee signature over the invoice key.
    /// @param amount Amount to pay, in base units; also the permit value.
    /// @param payerRef Payer-chosen reference echoed in `Paid`.
    /// @param p EIP-2612 permit signed by `msg.sender`.
    /// @return index Zero-based index of this payment within the link.
    function payWithPermit(
        Invoice calldata inv,
        bytes calldata payeeSig,
        uint128 amount,
        bytes32 payerRef,
        Permit calldata p
    ) external returns (uint32 index); // payer = msg.sender; permit in try/catch

    /// @notice Pays a native-coin invoice (`inv.token == address(0)`) with `msg.value`, forwarded to the payee
    ///         within the call.
    /// @param inv Invoice being paid.
    /// @param payeeSig Payee signature over the invoice key.
    /// @param payerRef Payer-chosen reference echoed in `Paid`.
    /// @return index Zero-based index of this payment within the link.
    function payNative(Invoice calldata inv, bytes calldata payeeSig, bytes32 payerRef)
        external
        payable
        returns (uint32 index); // payer = msg.sender, amount = msg.value

    // Revocation

    /// @notice Cancels a link permanently. Only the invoice's payee may call it.
    /// @dev Reverts `Cancelled` if the link is already cancelled. Sold-out and expired links can be cancelled.
    /// @param inv Invoice to cancel.
    function cancel(Invoice calldata inv) external; // msg.sender == payee

    /// @notice Cancels a link with the payee's EIP-712 `Cancel(bytes32 key,uint256 deadline)` signature, so a
    ///         relayer can revoke on the payee's behalf without the payee spending gas.
    /// @param inv Invoice to cancel.
    /// @param deadline Last second (inclusive) at which the cancel signature is accepted.
    /// @param payeeSig Payee signature over the Cancel digest (65-byte ECDSA, or ERC-1271 bytes).
    function cancelBySig(Invoice calldata inv, uint256 deadline, bytes calldata payeeSig) external;
    // EIP-712 Cancel(bytes32 key,uint256 deadline); relayable

    // Views

    /// @notice Returns the link id of an invoice under this deployment's domain.
    /// @param inv Invoice to hash.
    /// @return The EIP-712 digest `_hashTypedDataV4(hashStruct(inv))`; it commits to chainId and this contract.
    function invoiceKey(Invoice calldata inv) external view returns (bytes32); // _hashTypedDataV4(hashStruct(inv))

    /// @notice Returns the EIP-3009 token nonce that binds an authorization to one payment.
    /// @dev keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payer, amount, payerRef, payerSalt)).
    /// @param key Link id (already bound to chainId and verifyingContract).
    /// @param payer Token holder signing the authorization.
    /// @param amount Amount authorized.
    /// @param payerRef Payer reference that will be emitted in `Paid`.
    /// @param payerSalt Random value drawn once per intended payment (see `Authorization`).
    /// @return The nonce the payer must sign in `ReceiveWithAuthorization`.
    function paymentNonce(bytes32 key, address payer, uint128 amount, bytes32 payerRef, bytes32 payerSalt)
        external
        pure
        returns (bytes32);

    /// @notice Returns the state of one link (all zeroes for an unknown key).
    /// @param key Link id.
    /// @return The link's state.
    function stateOf(bytes32 key) external view returns (LinkState memory);

    /// @notice Returns the states of up to 256 links in one call.
    /// @dev Reverts `BatchTooLarge(256)` above 256 keys. Order and duplicates are preserved.
    /// @param keys Link ids.
    /// @return The links' states, in the order of `keys`.
    function statesOf(bytes32[] calldata keys) external view returns (LinkState[] memory); // ≤ 256 keys
    // + eip712Domain() (ERC-5267, from OZ EIP712); public constants INVOICE_TYPEHASH, CANCEL_TYPEHASH, PAYMENT_BINDING_TYPEHASH
}
