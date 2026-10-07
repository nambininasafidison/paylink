// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {Mock3009} from "../mocks/Mock3009.sol";
import {MockPermit} from "../mocks/MockPermit.sol";

/// @notice Shared fixture: one PayLinkV2, a 6-decimal EIP-3009 token, an 18-decimal EIP-2612 token, named actors
///         and signing helpers that are independent of the contract under test (digests are rebuilt from the
///         EIP-712 definitions, not read from PayLinkV2).
abstract contract BaseTest is Test {
    /// @dev secp256k1 group order; `n - s` gives the high-s twin of a signature.
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    /// @dev 2026-10-05 00:00:00 UTC.
    uint256 internal constant T0 = 1_791_158_400;

    bytes32 internal constant INVOICE_TYPEHASH = keccak256(
        "Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)"
    );
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 key,uint256 deadline)");
    bytes32 internal constant PAYMENT_BINDING_TYPEHASH =
        keccak256("PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint128 internal constant USDC_25 = 25e6;

    PayLinkV2 internal payLink;
    Mock3009 internal usdc;
    MockPermit internal musd;

    address internal payee;
    uint256 internal payeeKey;
    address internal payer;
    uint256 internal payerKey;
    address internal relayer;
    address internal stranger;
    uint256 internal strangerKey;

    uint256 private _saltNonce;

    function setUp() public virtual {
        vm.warp(T0);
        payLink = new PayLinkV2();
        usdc = new Mock3009("Mock USD Coin", "mUSDC", "2", 6);
        musd = new MockPermit("Mock Mezo USD", "mMUSD");

        (payee, payeeKey) = makeAddrAndKey("payee");
        (payer, payerKey) = makeAddrAndKey("payer");
        (stranger, strangerKey) = makeAddrAndKey("stranger");
        relayer = makeAddr("relayer");

        usdc.mint(payer, 1_000_000e6);
        musd.mint(payer, 1_000_000e18);
        vm.deal(payer, 1_000_000 ether);

        vm.label(address(payLink), "PayLinkV2");
        vm.label(address(usdc), "Mock3009");
        vm.label(address(musd), "MockPermit");
    }

    // ------------------------------------------------------------------ invoices

    /// @dev One-off invoice to `payee`, valid from now for 7 days, with a fresh salt.
    function _invoice(address token, uint128 amount) internal returns (IPayLinkV2.Invoice memory inv) {
        inv = IPayLinkV2.Invoice({
            payee: payee,
            token: token,
            amount: amount,
            validAfter: uint64(vm.getBlockTimestamp()),
            validUntil: uint64(vm.getBlockTimestamp() + 7 days),
            maxPayments: 1,
            salt: keccak256(abi.encode("salt", ++_saltNonce)),
            memoHash: keccak256("Invoice #12: logo design")
        });
    }

    function _invoiceN(address token, uint128 amount, uint32 maxPayments)
        internal
        returns (IPayLinkV2.Invoice memory inv)
    {
        inv = _invoice(token, amount);
        inv.maxPayments = maxPayments;
    }

    // ------------------------------------------------------------------ EIP-712 reference implementation

    function _domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("PayLink"), keccak256("2"), chainId, verifyingContract));
    }

    function _structHash(IPayLinkV2.Invoice memory inv) internal pure returns (bytes32) {
        return keccak256(
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
        );
    }

    function _keyFor(IPayLinkV2.Invoice memory inv, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(chainId, verifyingContract), _structHash(inv)));
    }

    /// @dev Link id under the main deployment and the current chain id.
    function _key(IPayLinkV2.Invoice memory inv) internal view returns (bytes32) {
        return _keyFor(inv, vm.getChainId(), address(payLink));
    }

    function _cancelDigest(bytes32 key, uint256 deadline, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator(chainId, verifyingContract),
                keccak256(abi.encode(CANCEL_TYPEHASH, key, deadline))
            )
        );
    }

    function _nonce(bytes32 key, address payerAddr, uint128 amount, bytes32 payerRef, bytes32 payerSalt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payerAddr, amount, payerRef, payerSalt));
    }

    // ------------------------------------------------------------------ signatures

    function _sign(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signInvoice(IPayLinkV2.Invoice memory inv) internal view returns (bytes memory) {
        return _sign(payeeKey, _key(inv));
    }

    function _signCancel(uint256 privateKey, IPayLinkV2.Invoice memory inv, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(privateKey, _cancelDigest(_key(inv), deadline, vm.getChainId(), address(payLink)));
    }

    /// @dev Same signer and digest, other valid-looking encoding: (r, n - s, v ^ 1). OZ ECDSA must reject it.
    function _highS(bytes memory sig) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        return abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "BaseTest: not a 65-byte signature");
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }

    // ------------------------------------------------------------------ token-side signatures

    function _tokenDomain(address token) internal view returns (bytes32) {
        return Mock3009(token).DOMAIN_SEPARATOR();
    }

    /// @dev EIP-3009 ReceiveWithAuthorization for `payerKey_` -> PayLink, nonce bound to the payment tuple.
    function _authorize(
        uint256 payerKey_,
        address token,
        bytes32 key,
        uint128 amount,
        bytes32 payerRef,
        bytes32 payerSalt
    ) internal view returns (IPayLinkV2.Authorization memory auth) {
        auth.payer = vm.addr(payerKey_);
        auth.amount = amount;
        auth.payerRef = payerRef;
        auth.payerSalt = payerSalt;
        auth.validAfter = vm.getBlockTimestamp() - 1;
        auth.validBefore = vm.getBlockTimestamp() + 1 hours;
        _signAuthorization(payerKey_, token, auth, _nonce(key, auth.payer, amount, payerRef, payerSalt));
    }

    /// @dev Signs `auth` (payer, amount and window as set by the caller) over an arbitrary token nonce, so tests can
    ///      forge mismatches. Writes v, r, s into `auth`.
    function _signAuthorization(uint256 payerKey_, address token, IPayLinkV2.Authorization memory auth, bytes32 nonce)
        internal
        view
    {
        bytes32 digest = _receiveDigest(token, auth.payer, auth.amount, auth.validAfter, auth.validBefore, nonce);
        (auth.v, auth.r, auth.s) = vm.sign(payerKey_, digest);
    }

    function _receiveDigest(
        address token,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _tokenDomain(token),
                keccak256(
                    abi.encode(
                        RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                        from,
                        address(payLink),
                        value,
                        validAfter,
                        validBefore,
                        nonce
                    )
                )
            )
        );
    }

    /// @dev Deep copy (memory struct assignment only copies the reference).
    function _clone(IPayLinkV2.Authorization memory auth) internal pure returns (IPayLinkV2.Authorization memory) {
        return abi.decode(abi.encode(auth), (IPayLinkV2.Authorization));
    }

    function _clone(IPayLinkV2.Invoice memory inv) internal pure returns (IPayLinkV2.Invoice memory) {
        return abi.decode(abi.encode(inv), (IPayLinkV2.Invoice));
    }

    /// @dev EIP-2612 permit owner -> PayLink for `value`, using the token's current nonce.
    function _permit(uint256 ownerKey, address token, uint256 value, uint256 deadline)
        internal
        view
        returns (IPayLinkV2.Permit memory p)
    {
        address owner = vm.addr(ownerKey);
        uint256 nonce = Mock3009(token).nonces(owner);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _tokenDomain(token),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(payLink), value, nonce, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        p = IPayLinkV2.Permit({deadline: deadline, v: v, r: r, s: s});
    }

    // ------------------------------------------------------------------ assertions

    function _assertState(bytes32 key, uint32 payments, bool cancelled, uint64 lastPaidAt, uint128 total)
        internal
        view
    {
        IPayLinkV2.LinkState memory st = payLink.stateOf(key);
        assertEq(st.payments, payments, "state.payments");
        assertEq(st.cancelled, cancelled, "state.cancelled");
        assertEq(st.lastPaidAt, lastPaidAt, "state.lastPaidAt");
        assertEq(st.total, total, "state.total");
    }
}
