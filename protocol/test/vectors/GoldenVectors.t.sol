// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

import {Json} from "../../script/utils/Json.sol";
import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {Mock3009} from "../mocks/Mock3009.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @title Golden vectors for cross-language parity (spec §3.5)
/// @notice Writes test/vectors/{eip712,nonce,cancel}.json. Every value is computed twice, by PayLinkV2 deployed at
///         each synthetic `verifyingContract` under each chain id, and by the independent EIP-712 reference in
///         BaseTest; the two must agree before anything is written. Signatures are then submitted to the contract
///         (payment, cancellation, and one complete EIP-3009 settlement), so every vector is proven to be accepted
///         on-chain, not only to hash consistently. The SDK's Vitest suite asserts it reproduces every value byte
///         for byte.
/// @dev Output is deterministic: CI regenerates it with `forge test` and fails on `git diff --exit-code
///      test/vectors`. Each file is parsed back after writing, so a malformed file fails here, not in Vitest.
///      Encoding: integers are decimal strings (most exceed 2^53); bytes are 0x-prefixed lowercase hex; addresses
///      are EIP-55; base64url is RFC 4648 §5 without `=` padding. Every address and key is a synthetic test value
///      derived from a public label (`_labelKey`, `_labelAddress`): never a real deployment, token or wallet.
contract GoldenVectorsTest is BaseTest {
    string internal constant DIR = "test/vectors/";
    string internal constant GENERATOR = "protocol/test/vectors/GoldenVectors.t.sol";
    string internal constant ENCODING =
        "integers: decimal strings; bytes: 0x-prefixed lowercase hex; addresses: EIP-55; base64url: RFC 4648 section 5, unpadded";
    string internal constant SYNTHETIC =
        "Test-only. Every private key and address is derived from a public label: privateKey = uint256(keccak256(label)) mod (n - 1) + 1, address = last 20 bytes of keccak256(label). Never use them for real funds.";
    string internal constant INVOICE_TYPE =
        "Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)";
    string internal constant DOMAIN_TYPE =
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

    string internal constant PAYEE_LABEL = "paylink.vectors.payee";
    string internal constant PAYER_LABEL = "paylink.vectors.payer";
    string internal constant CONTRACT_A_LABEL = "paylink.vectors.verifyingContract.A";
    string internal constant CONTRACT_B_LABEL = "paylink.vectors.verifyingContract.B";
    string internal constant USDC_LABEL = "paylink.vectors.token.usdc";
    string internal constant MUSD_LABEL = "paylink.vectors.token.musd";

    /// @dev 2026-10-05 00:00:00 UTC (BaseTest.T0) and seven days later.
    uint64 internal constant WINDOW_START = 1_791_158_400;
    uint64 internal constant WINDOW_END = 1_791_763_200;

    /// @dev Largest time value a conforming client accepts (docs/spec/paylink-invoice-v2.md §3.1, uint53 rule).
    uint64 internal constant UINT53_MAX = 2 ** 53 - 1;

    /// @dev One fixture: the invoice plus the memo it commits to (`hasMemo == false` means memoHash == 0).
    ///      `wireValid` is false for contract-level edge cases that conforming URL decoders must reject
    ///      (docs/spec/paylink-invoice-v2.md §10.5); those vectors carry no fragment.
    struct Fixture {
        string name;
        IPayLinkV2.Invoice inv;
        bool hasMemo;
        string memo;
        bool wireValid;
    }

    uint256 internal vectorPayeeKey;
    uint256 internal vectorPayerKey;
    address internal vectorPayee;
    address internal vectorPayer;
    address internal contractA;
    address internal contractB;

    function setUp() public override {
        super.setUp();
        vectorPayeeKey = _labelKey(PAYEE_LABEL);
        vectorPayerKey = _labelKey(PAYER_LABEL);
        vectorPayee = vm.addr(vectorPayeeKey);
        vectorPayer = vm.addr(vectorPayerKey);
        contractA = _labelAddress(CONTRACT_A_LABEL);
        contractB = _labelAddress(CONTRACT_B_LABEL);
    }

    /// @dev Chain ids from the spec's chain table (§3.4): anvil, Monad testnet and mainnet, Base Sepolia, Arbitrum
    ///      Sepolia, Mezo testnet, Arc testnet.
    function _chains() internal pure returns (uint256[7] memory) {
        return [uint256(31_337), 10_143, 143, 84_532, 421_614, 31_611, 5_042_002];
    }

    // ================================================================== eip712.json

    function test_WriteEip712Vectors() public {
        Fixture[] memory fixtures = _fixtures();
        uint256[7] memory chains = _chains();
        // Every fixture on the first domain; the typical invoice on each other (chainId, verifyingContract) pair.
        string[] memory items = new string[](fixtures.length + chains.length * 2 - 1);
        uint256 count;
        for (uint256 c = 0; c < chains.length; ++c) {
            for (uint256 d = 0; d < 2; ++d) {
                address verifying = d == 0 ? contractA : contractB;
                PayLinkV2 at = _deployAt(chains[c], verifying);
                uint256 n = (c == 0 && d == 0) ? fixtures.length : 1;
                for (uint256 i = 0; i < n; ++i) {
                    items[count++] = _eip712Vector(at, chains[c], verifying, fixtures[i]);
                }
            }
        }
        assertEq(count, items.length, "vector count");

        string[] memory top = new string[](9);
        top[0] = Json.str("schema", "paylink.vectors.eip712/1");
        top[1] = Json.str(
            "description",
            "PayLink v2 link ids: key = EIP-712 digest of Invoice under {name: PayLink, version: 2, chainId, verifyingContract}. Each signature is the payee's 65-byte ECDSA signature over key, accepted by the contract."
        );
        top[2] = Json.str("generator", GENERATOR);
        top[3] = Json.str("encoding", ENCODING);
        top[4] = Json.str("testOnly", SYNTHETIC);
        top[5] = Json.raw("domain", _domainTypeJson(1));
        top[6] = Json.raw("invoiceType", _invoiceTypeJson(1));
        top[7] = Json.raw("payee", _accountJson(PAYEE_LABEL, vectorPayeeKey, 1));
        top[8] = Json.raw("vectors", Json.arr(items, 1));
        _writeAndCheck("eip712.json", Json.obj(top, 0));

        string memory json = vm.readFile(string.concat(DIR, "eip712.json"));
        bytes32 key0 = _keyFor(fixtures[0].inv, chains[0], contractA);
        assertEq(vm.parseJsonBytes32(json, ".vectors[0].key"), key0, "round trip: key");
        assertEq(vm.parseJsonAddress(json, ".payee.address"), vectorPayee, "round trip: payee");
        assertEq(vm.parseJsonString(json, ".vectors[3].memo"), fixtures[3].memo, "round trip: UTF-8 memo");
    }

    function _eip712Vector(PayLinkV2 at, uint256 chainId, address verifying, Fixture memory f)
        internal
        returns (string memory)
    {
        IPayLinkV2.Invoice memory inv = f.inv;
        bytes32 key = _keyFor(inv, chainId, verifying);
        assertEq(at.invoiceKey(inv), key, "contract and reference keys differ");
        assertEq(inv.memoHash, f.hasMemo ? keccak256(bytes(f.memo)) : bytes32(0), "fixture memoHash");

        bytes memory packed = _packed(inv);
        assertEq(packed.length, 140, "packed invoice length");
        bytes memory sig = _sign(vectorPayeeKey, key);
        _assertPayable(at, inv, sig, key);

        string[] memory fields = new string[](14);
        fields[0] = Json.str("name", f.name);
        fields[1] = Json.str("chainId", vm.toString(chainId));
        fields[2] = Json.str("verifyingContract", vm.toString(verifying));
        fields[3] = Json.str("domainSeparator", vm.toString(_domainSeparator(chainId, verifying)));
        fields[4] = Json.raw("invoice", _invoiceJson(inv));
        fields[5] = f.hasMemo ? Json.str("memo", f.memo) : Json.raw("memo", "null");
        fields[6] = Json.str("structHash", vm.toString(_structHash(inv)));
        fields[7] = Json.str("key", vm.toString(key));
        fields[8] = Json.str("signature", vm.toString(sig));
        fields[9] = Json.str("packed", vm.toString(packed));
        fields[10] = Json.str("packedBase64url", Base64.encodeURL(packed));
        fields[11] = Json.str("signatureBase64url", Base64.encodeURL(sig));
        fields[12] = Json.raw("wireValid", f.wireValid ? "true" : "false");
        fields[13] =
            f.wireValid ? Json.str("fragment", _fragment(chainId, packed, sig, f)) : Json.raw("fragment", "null");
        return Json.obj(fields, 2);
    }

    /// @dev Pays the vector invoice on the deployment it was signed for (inside its window, with a token deployed at
    ///      the synthetic token address when needed), which proves the contract accepts the payee signature. All of
    ///      it is rolled back, so every vector starts from a clean deployment.
    function _assertPayable(PayLinkV2 at, IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) internal {
        uint256 ts = vm.getBlockTimestamp();
        uint256 snap = vm.snapshotState();
        if (ts < inv.validAfter || (inv.validUntil != 0 && ts > inv.validUntil)) vm.warp(inv.validAfter);
        uint128 amount = inv.amount == 0 ? 1 : inv.amount;
        vm.startPrank(vectorPayer);
        if (inv.token == address(0)) {
            vm.deal(vectorPayer, amount);
            at.payNative{value: amount}(inv, sig, bytes32(0));
        } else {
            deployCodeTo("Mock3009.sol:Mock3009", abi.encode("Vector Token", "VEC", "1", uint8(6)), inv.token);
            Mock3009(inv.token).mint(vectorPayer, amount);
            Mock3009(inv.token).approve(address(at), amount);
            at.pay(inv, sig, amount, bytes32(0));
            assertEq(Mock3009(inv.token).balanceOf(inv.payee), amount, "vector payment not credited");
        }
        vm.stopPrank();
        IPayLinkV2.LinkState memory st = at.stateOf(key);
        assertEq(st.payments, 1, "vector payee signature rejected");
        assertEq(st.total, amount, "vector total");
        vm.revertToState(snap);
        vm.warp(ts);
    }

    // ================================================================== nonce.json

    function test_WriteNonceVectors() public {
        uint256 chainId = 84_532;
        PayLinkV2 at = _deployAt(chainId, contractA);
        IPayLinkV2.Invoice memory inv = _fixtures()[0].inv;
        bytes32 key = _keyFor(inv, chainId, contractA);
        assertEq(at.invoiceKey(inv), key, "key");

        bytes32[5] memory refs =
            [bytes32(0), bytes32("INV-2026-0042"), keccak256("ref"), bytes32(type(uint256).max), bytes32(uint256(1))];
        uint128[5] memory amounts = [uint128(25_000_000), 1, 0, type(uint128).max, 1_500_000_000_000_000_000];
        string[] memory items = new string[](refs.length);
        for (uint256 i = 0; i < refs.length; ++i) {
            bytes32 payerSalt = keccak256(abi.encode("paylink.vectors.payerSalt", i));
            bytes32 nonce = _nonce(key, vectorPayer, amounts[i], refs[i], payerSalt);
            assertEq(at.paymentNonce(key, vectorPayer, amounts[i], refs[i], payerSalt), nonce, "nonce differs");
            string[] memory fields = new string[](6);
            fields[0] = Json.str("key", vm.toString(key));
            fields[1] = Json.str("payer", vm.toString(vectorPayer));
            fields[2] = Json.str("amount", vm.toString(amounts[i]));
            fields[3] = Json.str("payerRef", vm.toString(refs[i]));
            fields[4] = Json.str("payerSalt", vm.toString(payerSalt));
            fields[5] = Json.str("nonce", vm.toString(nonce));
            items[i] = Json.obj(fields, 2);
        }

        string[] memory top = new string[](10);
        top[0] = Json.str("schema", "paylink.vectors.nonce/1");
        top[1] = Json.str(
            "description",
            "EIP-3009 token nonce bound to one payment: nonce = keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payer, amount, payerRef, payerSalt)). key already commits to chainId and verifyingContract."
        );
        top[2] = Json.str("generator", GENERATOR);
        top[3] = Json.str("encoding", ENCODING);
        top[4] = Json.str("testOnly", SYNTHETIC);
        top[5] = Json.str(
            "typeString", "PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)"
        );
        top[6] = Json.str("typeHash", vm.toString(PAYMENT_BINDING_TYPEHASH));
        top[7] = Json.raw("payer", _accountJson(PAYER_LABEL, vectorPayerKey, 1));
        top[8] = Json.raw("vectors", Json.arr(items, 1));
        top[9] = Json.raw("receiveWithAuthorization", _settledAuthorization(at, inv, key, refs[1]));
        _writeAndCheck("nonce.json", Json.obj(top, 0));

        string memory json = vm.readFile(string.concat(DIR, "nonce.json"));
        assertEq(
            vm.parseJsonBytes32(json, ".vectors[1].nonce"),
            _nonce(key, vectorPayer, 1, refs[1], keccak256(abi.encode("paylink.vectors.payerSalt", uint256(1)))),
            "round trip: nonce"
        );
        assertEq(vm.parseJsonString(json, ".vectors[3].amount"), "340282366920938463463374607431768211455");
    }

    /// @dev An EIP-3009 authorization vector: the signed authorization plus the token-side values it commits to.
    struct AuthVector {
        address token;
        address to;
        bytes32 key;
        bytes32 tokenDomain;
        bytes32 nonce;
        bytes32 digest;
        IPayLinkV2.Authorization auth;
    }

    /// @dev One complete EIP-3009 `ReceiveWithAuthorization` over the bound nonce, under a USDC-like token domain
    ///      {USDC, 2, 84532, synthetic token}. The token is deployed at the synthetic address and the authorization
    ///      is settled through `payWithAuthorization`, so the vector is proven end to end.
    function _settledAuthorization(PayLinkV2 at, IPayLinkV2.Invoice memory inv, bytes32 key, bytes32 payerRef)
        internal
        returns (string memory)
    {
        deployCodeTo("Mock3009.sol:Mock3009", abi.encode("USDC", "USDC", "2", uint8(6)), inv.token);
        AuthVector memory a = _authVector(address(at), inv, key, payerRef);
        Mock3009 token = Mock3009(inv.token);
        assertEq(token.DOMAIN_SEPARATOR(), a.tokenDomain, "token domain");

        // Settle it with the payee signature of eip712.json for this domain; this test acts as the relayer.
        uint256 snap = vm.snapshotState();
        vm.warp(WINDOW_START);
        token.mint(vectorPayer, a.auth.amount);
        at.payWithAuthorization(inv, _sign(vectorPayeeKey, key), a.auth);
        assertEq(token.balanceOf(inv.payee), a.auth.amount, "vector authorization did not settle");
        assertEq(token.balanceOf(address(at)), 0, "pass-through left a balance");
        assertTrue(token.authorizationState(vectorPayer, a.nonce), "bound nonce not consumed");
        vm.revertToState(snap);
        return _authVectorJson(a);
    }

    function _authVector(address to, IPayLinkV2.Invoice memory inv, bytes32 key, bytes32 payerRef)
        internal
        view
        returns (AuthVector memory a)
    {
        a.token = inv.token;
        a.to = to;
        a.key = key;
        a.auth.payer = vectorPayer;
        a.auth.amount = inv.amount;
        a.auth.payerRef = payerRef;
        a.auth.payerSalt = keccak256(abi.encode("paylink.vectors.payerSalt", uint256(0)));
        a.auth.validAfter = WINDOW_START - 1;
        a.auth.validBefore = WINDOW_START + 1 hours;
        a.nonce = _nonce(key, a.auth.payer, a.auth.amount, a.auth.payerRef, a.auth.payerSalt);
        a.tokenDomain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("USDC"), keccak256("2"), block.chainid, a.token));
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                a.auth.payer,
                to,
                uint256(a.auth.amount),
                a.auth.validAfter,
                a.auth.validBefore,
                a.nonce
            )
        );
        a.digest = keccak256(abi.encodePacked("\x19\x01", a.tokenDomain, structHash));
        (a.auth.v, a.auth.r, a.auth.s) = vm.sign(vectorPayerKey, a.digest);
    }

    function _authVectorJson(AuthVector memory a) internal view returns (string memory) {
        string[] memory f = new string[](21);
        f[0] = Json.str("tokenName", "USDC");
        f[1] = Json.str("tokenVersion", "2");
        f[2] = Json.str("chainId", vm.toString(block.chainid));
        f[3] = Json.str("token", vm.toString(a.token));
        f[4] = Json.str("tokenDomainSeparator", vm.toString(a.tokenDomain));
        f[5] = Json.str(
            "typeString",
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
        f[6] = Json.str("typeHash", vm.toString(RECEIVE_WITH_AUTHORIZATION_TYPEHASH));
        f[7] = Json.str("key", vm.toString(a.key));
        f[8] = Json.str("from", vm.toString(a.auth.payer));
        f[9] = Json.str("to", vm.toString(a.to));
        f[10] = Json.str("value", vm.toString(a.auth.amount));
        f[11] = Json.str("validAfter", vm.toString(a.auth.validAfter));
        f[12] = Json.str("validBefore", vm.toString(a.auth.validBefore));
        f[13] = Json.str("payerRef", vm.toString(a.auth.payerRef));
        f[14] = Json.str("payerSalt", vm.toString(a.auth.payerSalt));
        f[15] = Json.str("nonce", vm.toString(a.nonce));
        f[16] = Json.str("digest", vm.toString(a.digest));
        f[17] = Json.str("v", vm.toString(a.auth.v));
        f[18] = Json.str("r", vm.toString(a.auth.r));
        f[19] = Json.str("s", vm.toString(a.auth.s));
        f[20] = Json.str("note", "to is the PayLinkV2 deployment (receiveWithAuthorization requires to == msg.sender)");
        return Json.obj(f, 1);
    }

    // ================================================================== cancel.json

    function test_WriteCancelVectors() public {
        IPayLinkV2.Invoice memory inv = _fixtures()[0].inv;
        uint256[7] memory chains = _chains();
        // Deadline variants on the first chain: already expired (0), the invoice's own expiry, never.
        uint256[3] memory deadlines = [uint256(0), WINDOW_END, type(uint256).max];
        string[] memory items = new string[](chains.length + 2);
        uint256 count;
        for (uint256 c = 0; c < chains.length; ++c) {
            PayLinkV2 at = _deployAt(chains[c], contractA);
            bytes32 key = _keyFor(inv, chains[c], contractA);
            assertEq(at.invoiceKey(inv), key, "key");
            for (uint256 j = 0; j < (c == 0 ? 3 : 1); ++j) {
                items[count++] = _cancelVector(at, chains[c], inv, key, deadlines[c == 0 ? j : 1]);
            }
        }
        assertEq(count, items.length, "vector count");

        string[] memory top = new string[](10);
        top[0] = Json.str("schema", "paylink.vectors.cancel/1");
        top[1] = Json.str(
            "description",
            "Gasless revocation: EIP-712 Cancel(bytes32 key,uint256 deadline) under the PayLink domain. The deadline is inclusive; the contract reverts SignatureExpired(deadline) once block.timestamp > deadline."
        );
        top[2] = Json.str("generator", GENERATOR);
        top[3] = Json.str("encoding", ENCODING);
        top[4] = Json.str("testOnly", SYNTHETIC);
        top[5] = Json.str("typeString", "Cancel(bytes32 key,uint256 deadline)");
        top[6] = Json.str("typeHash", vm.toString(CANCEL_TYPEHASH));
        top[7] = Json.raw("payee", _accountJson(PAYEE_LABEL, vectorPayeeKey, 1));
        top[8] = Json.raw("invoice", _invoiceJson(inv));
        top[9] = Json.raw("vectors", Json.arr(items, 1));
        _writeAndCheck("cancel.json", Json.obj(top, 0));

        string memory json = vm.readFile(string.concat(DIR, "cancel.json"));
        assertEq(vm.parseJsonString(json, ".vectors[2].deadline"), vm.toString(type(uint256).max));
        assertEq(vm.parseJsonBool(json, ".vectors[0].acceptedAtGenerationTime"), false);
    }

    function _cancelVector(PayLinkV2 at, uint256 chainId, IPayLinkV2.Invoice memory inv, bytes32 key, uint256 deadline)
        internal
        returns (string memory)
    {
        bytes32 digest = _cancelDigest(key, deadline, chainId, address(at));
        bytes memory sig = _sign(vectorPayeeKey, digest);
        bool accepted = _assertCancel(at, inv, key, deadline, sig);

        string[] memory f = new string[](8);
        f[0] = Json.str("chainId", vm.toString(chainId));
        f[1] = Json.str("verifyingContract", vm.toString(address(at)));
        f[2] = Json.str("key", vm.toString(key));
        f[3] = Json.str("deadline", vm.toString(deadline));
        f[4] = Json.str("structHash", vm.toString(keccak256(abi.encode(CANCEL_TYPEHASH, key, deadline))));
        f[5] = Json.str("digest", vm.toString(digest));
        f[6] = Json.str("signature", vm.toString(sig));
        f[7] = Json.raw("acceptedAtGenerationTime", accepted ? "true" : "false");
        return Json.obj(f, 2);
    }

    /// @dev Submits the vector: the contract accepts exactly this signature unless the deadline has passed, in which
    ///      case it reverts `SignatureExpired(deadline)`. Rolled back afterwards.
    function _assertCancel(PayLinkV2 at, IPayLinkV2.Invoice memory inv, bytes32 key, uint256 deadline, bytes memory sig)
        internal
        returns (bool accepted)
    {
        accepted = deadline >= vm.getBlockTimestamp();
        uint256 snap = vm.snapshotState();
        if (accepted) {
            vm.expectEmit(true, true, true, true, address(at));
            emit IPayLinkV2.InvoiceCancelled(key, inv.payee);
            at.cancelBySig(inv, deadline, sig);
            assertTrue(at.stateOf(key).cancelled, "vector cancel signature rejected");
        } else {
            vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.SignatureExpired.selector, deadline));
            at.cancelBySig(inv, deadline, sig);
        }
        vm.revertToState(snap);
    }

    // ================================================================== fixtures

    function _fixtures() internal view returns (Fixture[] memory list) {
        list = new Fixture[](6);
        list[0] = _fixture(
            "typical one-off invoice: 25.000000 of a 6-decimal token, 7-day window",
            IPayLinkV2.Invoice({
                payee: vectorPayee,
                token: _labelAddress(USDC_LABEL),
                amount: 25_000_000,
                validAfter: WINDOW_START,
                validUntil: WINDOW_END,
                maxPayments: 1,
                salt: keccak256("paylink.vectors.salt.0"),
                memoHash: 0
            }),
            "Logo design, invoice #12",
            true
        );
        list[1] = _fixture(
            "receive card: native coin, open amount, unlimited payments, no expiry, no memo",
            IPayLinkV2.Invoice({
                payee: vectorPayee,
                token: address(0),
                amount: 0,
                validAfter: 0,
                validUntil: 0,
                maxPayments: 0,
                salt: keccak256("paylink.vectors.salt.1"),
                memoHash: 0
            }),
            "",
            true
        );
        list[2] = _fixture(
            "largest wire-valid values: times at 2^53 - 1, maximum amount and seats, all-ones token and salt, 280-byte memo",
            IPayLinkV2.Invoice({
                payee: vectorPayee,
                token: address(type(uint160).max),
                amount: type(uint128).max,
                validAfter: UINT53_MAX,
                validUntil: UINT53_MAX,
                maxPayments: type(uint32).max,
                salt: bytes32(type(uint256).max),
                memoHash: 0
            }),
            _repeat("PayLink ", 35),
            true
        );
        list[3] = _fixture(
            "18-decimal token, 1.5 per seat, 10 seats, multi-byte UTF-8 memo",
            IPayLinkV2.Invoice({
                payee: vectorPayee,
                token: _labelAddress(MUSD_LABEL),
                amount: 1_500_000_000_000_000_000,
                validAfter: WINDOW_START,
                validUntil: WINDOW_START + 1 days,
                maxPayments: 10,
                salt: keccak256("paylink.vectors.salt.3"),
                memoHash: 0
            }),
            unicode"Saran'ny sakafo, latabatra 4 — Antananarivo ✓",
            true
        );
        list[4] = _fixture(
            "encoding edge cases: zero salt, smallest non-zero amount and window, single payment, no memo",
            IPayLinkV2.Invoice({
                payee: vectorPayee,
                token: _labelAddress(USDC_LABEL),
                amount: 1,
                validAfter: 1,
                validUntil: 1,
                maxPayments: 1,
                salt: bytes32(0),
                memoHash: 0
            }),
            "",
            true
        );
        list[5] = _fixture(
            "contract-only edge case: uint64 maxima above the uint53 wire limit; payable on-chain, rejected by conforming clients (E_UINT53_RANGE)",
            IPayLinkV2.Invoice({
                payee: vectorPayee,
                token: _labelAddress(USDC_LABEL),
                amount: type(uint128).max,
                validAfter: type(uint64).max,
                validUntil: type(uint64).max,
                maxPayments: type(uint32).max,
                salt: keccak256("paylink.vectors.salt.5"),
                memoHash: 0
            }),
            "",
            false
        );
        assertEq(bytes(list[2].memo).length, 280, "max memo length");
    }

    /// @dev Builds a fixture; an empty memo means "no memo" (memoHash 0), as in the URL format.
    function _fixture(string memory name, IPayLinkV2.Invoice memory inv, string memory memo, bool wireValid)
        internal
        pure
        returns (Fixture memory f)
    {
        f.name = name;
        f.inv = inv;
        f.wireValid = wireValid;
        f.hasMemo = bytes(memo).length != 0;
        f.memo = memo;
        if (f.hasMemo) f.inv.memoHash = keccak256(bytes(memo));
    }

    // ================================================================== encodings

    /// @dev payee 20 | token 20 | amount 16 | validAfter 8 | validUntil 8 | maxPayments 4 | salt 32 | memoHash 32.
    function _packed(IPayLinkV2.Invoice memory inv) internal pure returns (bytes memory) {
        return abi.encodePacked(
            inv.payee, inv.token, inv.amount, inv.validAfter, inv.validUntil, inv.maxPayments, inv.salt, inv.memoHash
        );
    }

    /// @dev URL fragment `2.<chainId>.<inv>.<sig>[.<memo>]` (spec §3.5), all segments unpadded base64url.
    function _fragment(uint256 chainId, bytes memory packed, bytes memory sig, Fixture memory f)
        internal
        pure
        returns (string memory s)
    {
        s = string.concat("2.", vm.toString(chainId), ".", Base64.encodeURL(packed), ".", Base64.encodeURL(sig));
        if (f.hasMemo) s = string.concat(s, ".", Base64.encodeURL(bytes(f.memo)));
    }

    function _deployAt(uint256 chainId, address at) internal returns (PayLinkV2) {
        vm.chainId(chainId);
        deployCodeTo("PayLinkV2.sol:PayLinkV2", at);
        return PayLinkV2(payable(at));
    }

    function _labelKey(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(bytes(label))) % (SECP256K1_N - 1) + 1;
    }

    function _labelAddress(string memory label) internal pure returns (address) {
        return address(uint160(uint256(keccak256(bytes(label)))));
    }

    function _repeat(string memory unit, uint256 times) internal pure returns (string memory s) {
        for (uint256 i = 0; i < times; ++i) {
            s = string.concat(s, unit);
        }
    }

    // ================================================================== deterministic JSON

    function _writeAndCheck(string memory file, string memory json) internal {
        string memory path = string.concat(DIR, file);
        vm.writeFile(path, string.concat(json, "\n"));
        // Parses the whole document: a malformed file fails here.
        vm.parseJson(vm.readFile(path));
    }

    function _domainTypeJson(uint256 indent) internal pure returns (string memory) {
        string[] memory f = new string[](4);
        f[0] = Json.str("typeString", DOMAIN_TYPE);
        f[1] = Json.str("typeHash", vm.toString(DOMAIN_TYPEHASH));
        f[2] = Json.str("name", "PayLink");
        f[3] = Json.str("version", "2");
        return Json.obj(f, indent);
    }

    function _invoiceTypeJson(uint256 indent) internal pure returns (string memory) {
        string[] memory f = new string[](4);
        f[0] = Json.str("typeString", INVOICE_TYPE);
        f[1] = Json.str("typeHash", vm.toString(INVOICE_TYPEHASH));
        f[2] = Json.str(
            "packedLayout",
            "payee 20 | token 20 | amount 16 | validAfter 8 | validUntil 8 | maxPayments 4 | salt 32 | memoHash 32 (140 bytes, big-endian)"
        );
        f[3] =
            Json.str("signatureEncoding", "r 32 | s 32 | v 1 (65 bytes, low-s, v in {27, 28}, RFC 6979 deterministic)");
        return Json.obj(f, indent);
    }

    function _accountJson(string memory label, uint256 privateKey, uint256 indent)
        internal
        pure
        returns (string memory)
    {
        string[] memory f = new string[](3);
        f[0] = Json.str("label", label);
        f[1] = Json.str("privateKey", vm.toString(bytes32(privateKey)));
        f[2] = Json.str("address", vm.toString(vm.addr(privateKey)));
        return Json.obj(f, indent);
    }

    function _invoiceJson(IPayLinkV2.Invoice memory inv) internal pure returns (string memory) {
        string[] memory f = new string[](8);
        f[0] = Json.str("payee", vm.toString(inv.payee));
        f[1] = Json.str("token", vm.toString(inv.token));
        f[2] = Json.str("amount", vm.toString(inv.amount));
        f[3] = Json.str("validAfter", vm.toString(inv.validAfter));
        f[4] = Json.str("validUntil", vm.toString(inv.validUntil));
        f[5] = Json.str("maxPayments", vm.toString(inv.maxPayments));
        f[6] = Json.str("salt", vm.toString(inv.salt));
        f[7] = Json.str("memoHash", vm.toString(inv.memoHash));
        return Json.oneLine(f);
    }
}
