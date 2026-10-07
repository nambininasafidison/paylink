// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @title The published format document agrees with the contract
/// @notice Every literal value in docs/spec/paylink-invoice-v2.md §7.6 and §17 (type hashes, event topics,
///         function and error selectors, the worked example's key, signature, packed bytes and URL fragment, the
///         cross-chain key, the payment binding nonce and the signed cancellation) is asserted here against the
///         compiled PayLinkV2 deployed exactly as the document describes. The document's values were computed with
///         ethers 6.17.0 and Foundry cast; this test is the third, independent implementation. If the document or
///         the contract changes, CI fails until they agree again.
/// @dev The keys are anvil's public default accounts (mnemonic "test test ... junk"), as in the document.
contract SpecExamplesTest is BaseTest {
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";

    // ---- §17.3 inputs
    uint256 internal constant EXAMPLE_CHAIN = 10_143;
    address internal constant EXAMPLE_CONTRACT = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
    address internal constant EXAMPLE_PAYEE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant EXAMPLE_TOKEN = 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512;
    address internal constant EXAMPLE_PAYER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    // ---- §17.3 outputs
    bytes32 internal constant DOC_DOMAIN_SEPARATOR = 0x084875ae6ab8d0ac0c9e0e1d2537f8985030baab1d0bfac09d4e0bdac024c27c;
    bytes32 internal constant DOC_STRUCT_HASH = 0x43d51889ef0cc89661659d7d1db9a8fc5e52fabf7dbff2ad3a8307d6ad69a110;
    bytes32 internal constant DOC_KEY = 0x7c3bfd66020e278626ebe781b4d26210c763273be3b3c2be4f90bb1631df15df;
    bytes internal constant DOC_SIGNATURE =
        hex"9b15ca287effb6724dbbdc508dc3f8418c1c51e38c7df32be3da03a1487de3615537f23f136bfa824748e8a730f38c4ad407223d8f6fd1e9b9ac4309cd6dd1b41b";
    bytes internal constant DOC_PACKED =
        hex"70997970c51812dc3a010c7d01b50e0d17dc79c8e7f1725e7734ce288f8367e1bb143e90bb3f0512000000000000000000000000017d7840000000006ac2e880000000006acc230000000001f5b34bf6f093a9e7f2275058fccc4b4c517ce2b35455c8f6908d9cff07c148d59e4171ef418f2c980507bfa20f7262b37301d7ffd5d6ef27634ca2d85d6b7041";
    string internal constant DOC_FRAGMENT =
        "2.10143.cJl5cMUYEtw6AQx9AbUODRfcecjn8XJedzTOKI-DZ-G7FD6Quz8FEgAAAAAAAAAAAAAAAAF9eEAAAAAAasLogAAAAABqzCMAAAAAAfWzS_bwk6nn8idQWPzMS0xRfOKzVFXI9pCNnP8HwUjVnkFx70GPLJgFB7-iD3Jis3MB1__V1u8nY0yi2F1rcEE.mxXKKH7_tnJNu9xQjcP4QYwcUeOMffMr49oDoUh942FVN_I_E2v6gkdI6Kcw84xK1AciPY9v0em5rEMJzW3RtBs.TG9nbyBkZXNpZ24sIGludm9pY2UgIzEy";

    // ---- §17.4, §17.5, §17.6
    bytes32 internal constant DOC_KEY_84532 = 0x51051ac00b30aaee2966aa10faa3d1258492509709a21b179aff066c2bcbed2f;
    bytes32 internal constant DOC_NONCE = 0xfb35fc12f5759b9a2eda33480fb501423cc85685589966e4d1f378eef8888089;
    uint256 internal constant DOC_CANCEL_DEADLINE = 1_791_244_800;
    bytes32 internal constant DOC_CANCEL_DIGEST = 0xbee48c48fa887318cf8227108e5578be937b736a207dc284a8224f58974696fa;
    bytes internal constant DOC_CANCEL_SIGNATURE =
        hex"7aa4bdfaba049e3148492fb392beba80d7c4b9bbb10a9869fe4c182b53263ec43d641475ef1ed97431720670eb92c823c985d09cf941ca38a928954697cdfd141c";

    uint256 internal examplePayeeKey;
    PayLinkV2 internal example;

    function setUp() public override {
        super.setUp();
        examplePayeeKey = vm.deriveKey(MNEMONIC, 1);
        assertEq(vm.addr(examplePayeeKey), EXAMPLE_PAYEE, "anvil account 1");
        assertEq(vm.addr(vm.deriveKey(MNEMONIC, 2)), EXAMPLE_PAYER, "anvil account 2");
        example = _deployAt(EXAMPLE_CHAIN, EXAMPLE_CONTRACT);
    }

    function _exampleInvoice() internal pure returns (IPayLinkV2.Invoice memory) {
        return IPayLinkV2.Invoice({
            payee: EXAMPLE_PAYEE,
            token: EXAMPLE_TOKEN,
            amount: 25_000_000,
            validAfter: 1_791_158_400,
            validUntil: 1_791_763_200,
            maxPayments: 1,
            salt: keccak256("PayLink invoice v2 example salt"),
            memoHash: keccak256("Logo design, invoice #12")
        });
    }

    function _deployAt(uint256 chainId, address at) internal returns (PayLinkV2) {
        vm.chainId(chainId);
        deployCodeTo("PayLinkV2.sol:PayLinkV2", at);
        return PayLinkV2(payable(at));
    }

    // ------------------------------------------------------------------ §17.1 type hashes and topics

    function test_Section17_1_TypeHashesAndTopics() public view {
        assertEq(DOMAIN_TYPEHASH, 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f, "EIP712Domain");
        assertEq(
            example.INVOICE_TYPEHASH(), 0x8b0d4e92e431b40f1455755e745c6d48d699d52b9a141b56f0a079793050708e, "Invoice"
        );
        assertEq(
            example.CANCEL_TYPEHASH(), 0x9e17c698745faeba552ac9e0fa17b141be25ab98edd4766f24b1054263080465, "Cancel"
        );
        assertEq(
            example.PAYMENT_BINDING_TYPEHASH(),
            0x1522042427c11deedb016d62cb8d2ed977e5ba802ccb926d4a8fa50abd9af353,
            "PayLinkPayment"
        );
        assertEq(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
            0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8,
            "ReceiveWithAuthorization"
        );
        assertEq(IPayLinkV2.Paid.selector, 0xca30d10d6510d85eb6fa9e2f49f80fc8e789aac9619c3000f100dfa51fd7b31d, "Paid");
        assertEq(
            IPayLinkV2.InvoiceCancelled.selector,
            0x881d07924d83735d00c06370239f77e65622c5033b00ccd03a9358be68de819d,
            "InvoiceCancelled"
        );
        assertEq(keccak256(""), 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470, "keccak256('')");
    }

    // ------------------------------------------------------------------ §17.2 function selectors

    function test_Section17_2_FunctionSelectors() public view {
        assertEq(IPayLinkV2.payWithAuthorization.selector, bytes4(0xa4c514ef), "payWithAuthorization");
        assertEq(IPayLinkV2.cancelBySig.selector, bytes4(0x47e6460e), "cancelBySig");
        assertEq(IPayLinkV2.pay.selector, bytes4(0x861df419), "pay");
        assertEq(IPayLinkV2.payWithPermit.selector, bytes4(0x7b0a31f7), "payWithPermit");
        assertEq(IPayLinkV2.payNative.selector, bytes4(0x19a6b20e), "payNative");
        assertEq(IPayLinkV2.cancel.selector, bytes4(0xb7eb2e37), "cancel");
        assertEq(IPayLinkV2.invoiceKey.selector, bytes4(0x4eeaa709), "invoiceKey");
        assertEq(IPayLinkV2.paymentNonce.selector, bytes4(0x2ec920ac), "paymentNonce");
        assertEq(IPayLinkV2.stateOf.selector, bytes4(0x64482ac4), "stateOf");
        assertEq(IPayLinkV2.statesOf.selector, bytes4(0xf8b72a0b), "statesOf");
        assertEq(example.eip712Domain.selector, bytes4(0x84b0196e), "eip712Domain");
        assertEq(example.INVOICE_TYPEHASH.selector, bytes4(0x4fe1681a), "INVOICE_TYPEHASH()");
        assertEq(example.CANCEL_TYPEHASH.selector, bytes4(0x73fca6ea), "CANCEL_TYPEHASH()");
        assertEq(example.PAYMENT_BINDING_TYPEHASH.selector, bytes4(0xda66ed9f), "PAYMENT_BINDING_TYPEHASH()");
    }

    // ------------------------------------------------------------------ §7.6 error catalogue

    function test_Section7_6_ErrorSelectors() public pure {
        assertEq(IPayLinkV2.InvalidInvoice.selector, bytes4(0x93fe191e), "InvalidInvoice");
        assertEq(IPayLinkV2.InvalidSignature.selector, bytes4(0x8baa579f), "InvalidSignature");
        assertEq(IPayLinkV2.SignatureExpired.selector, bytes4(0xcd21db4f), "SignatureExpired");
        assertEq(IPayLinkV2.NotPayee.selector, bytes4(0x56cab67b), "NotPayee");
        assertEq(IPayLinkV2.Cancelled.selector, bytes4(0x63b95884), "Cancelled");
        assertEq(IPayLinkV2.NotYetValid.selector, bytes4(0x2d5d879e), "NotYetValid");
        assertEq(IPayLinkV2.Expired.selector, bytes4(0x95693653), "Expired");
        assertEq(IPayLinkV2.SoldOut.selector, bytes4(0x1166dd6e), "SoldOut");
        assertEq(IPayLinkV2.WrongAmount.selector, bytes4(0x96eb4103), "WrongAmount");
        assertEq(IPayLinkV2.WrongPaymentPath.selector, bytes4(0x99c891ea), "WrongPaymentPath");
        assertEq(IPayLinkV2.SelfPayment.selector, bytes4(0x82987a24), "SelfPayment");
        assertEq(IPayLinkV2.ReceivedMismatch.selector, bytes4(0x53ee4726), "ReceivedMismatch");
        assertEq(IPayLinkV2.PayeeShortPaid.selector, bytes4(0x9de8f254), "PayeeShortPaid");
        assertEq(IPayLinkV2.BatchTooLarge.selector, bytes4(0xa67b9f9e), "BatchTooLarge");
        assertEq(ReentrancyGuard.ReentrancyGuardReentrantCall.selector, bytes4(0x3ee5aeb5), "ReentrancyGuard");
        assertEq(bytes4(keccak256("SafeERC20FailedOperation(address)")), bytes4(0x5274afe7), "SafeERC20");
        assertEq(bytes4(keccak256("InsufficientBalance(uint256,uint256)")), bytes4(0xcf479181), "Errors.Insufficient");
        assertEq(bytes4(keccak256("FailedCall()")), bytes4(0xd6bda275), "Errors.FailedCall");
    }

    // ------------------------------------------------------------------ §17.3 worked example

    function test_Section17_3_ExampleInvoice() public view {
        IPayLinkV2.Invoice memory inv = _exampleInvoice();
        assertEq(inv.salt, 0xf5b34bf6f093a9e7f2275058fccc4b4c517ce2b35455c8f6908d9cff07c148d5, "salt");
        assertEq(inv.memoHash, 0x9e4171ef418f2c980507bfa20f7262b37301d7ffd5d6ef27634ca2d85d6b7041, "memoHash");

        assertEq(_domainSeparator(EXAMPLE_CHAIN, EXAMPLE_CONTRACT), DOC_DOMAIN_SEPARATOR, "domain separator");
        assertEq(_structHash(inv), DOC_STRUCT_HASH, "struct hash");
        assertEq(example.invoiceKey(inv), DOC_KEY, "key (contract)");
        assertEq(_keyFor(inv, EXAMPLE_CHAIN, EXAMPLE_CONTRACT), DOC_KEY, "key (reference)");

        // RFC 6979 is deterministic: Foundry, ethers and cast produce the same bytes.
        assertEq(_sign(examplePayeeKey, DOC_KEY), DOC_SIGNATURE, "payee signature");

        bytes memory packed = abi.encodePacked(
            inv.payee, inv.token, inv.amount, inv.validAfter, inv.validUntil, inv.maxPayments, inv.salt, inv.memoHash
        );
        assertEq(packed, DOC_PACKED, "packed invoice");
        string memory fragment = string.concat(
            "2.10143.",
            Base64.encodeURL(packed),
            ".",
            Base64.encodeURL(DOC_SIGNATURE),
            ".",
            Base64.encodeURL(bytes("Logo design, invoice #12"))
        );
        assertEq(fragment, DOC_FRAGMENT, "fragment");
        assertEq(bytes(fragment).length, 316, "fragment length");
    }

    /// @notice The documented example is not only consistent: the contract settles it with the documented
    ///         signature, inside the documented window, and rejects it on another chain.
    function test_Section17_3_ExampleIsPayableWithTheDocumentedSignature() public {
        IPayLinkV2.Invoice memory inv = _exampleInvoice();
        deployCodeTo("Mock3009.sol:Mock3009", abi.encode("Example Token", "EXT", "2", uint8(6)), EXAMPLE_TOKEN);
        (bool ok,) = EXAMPLE_TOKEN.call(abi.encodeWithSignature("mint(address,uint256)", EXAMPLE_PAYER, 25_000_000));
        assertTrue(ok);
        vm.startPrank(EXAMPLE_PAYER);
        (ok,) = EXAMPLE_TOKEN.call(abi.encodeWithSignature("approve(address,uint256)", EXAMPLE_CONTRACT, 25_000_000));
        assertTrue(ok);
        assertEq(example.pay(inv, DOC_SIGNATURE, 25_000_000, bytes32(0)), 0, "index");
        vm.stopPrank();
        assertEq(example.stateOf(DOC_KEY).total, 25_000_000, "settled");
    }

    // ------------------------------------------------------------------ §17.4 cross-chain key

    function test_Section17_4_CrossChainKey() public {
        IPayLinkV2.Invoice memory inv = _exampleInvoice();
        PayLinkV2 onBase = _deployAt(84_532, EXAMPLE_CONTRACT);
        assertEq(onBase.invoiceKey(inv), DOC_KEY_84532, "key on 84532");
        assertEq(_keyFor(inv, 84_532, EXAMPLE_CONTRACT), DOC_KEY_84532, "reference key on 84532");

        vm.prank(EXAMPLE_PAYER);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        onBase.pay(inv, DOC_SIGNATURE, 25_000_000, bytes32(0));
    }

    // ------------------------------------------------------------------ §17.5 payment binding

    function test_Section17_5_PaymentBinding() public view {
        bytes32 payerSalt = keccak256("PayLink payment example payer salt");
        assertEq(payerSalt, 0x27d8d8eed2e9a08f43724320ccef15205d4c343948c66ee817abd9c4721f4303, "payerSalt");
        assertEq(example.paymentNonce(DOC_KEY, EXAMPLE_PAYER, 25_000_000, bytes32(0), payerSalt), DOC_NONCE, "nonce");
        assertEq(_nonce(DOC_KEY, EXAMPLE_PAYER, 25_000_000, bytes32(0), payerSalt), DOC_NONCE, "reference nonce");
    }

    // ------------------------------------------------------------------ §17.6 signed cancellation

    function test_Section17_6_SignedCancellation() public {
        assertEq(
            _cancelDigest(DOC_KEY, DOC_CANCEL_DEADLINE, EXAMPLE_CHAIN, EXAMPLE_CONTRACT), DOC_CANCEL_DIGEST, "digest"
        );
        assertEq(_sign(examplePayeeKey, DOC_CANCEL_DIGEST), DOC_CANCEL_SIGNATURE, "cancel signature");

        // Accepted by the contract up to and including the deadline, from any relayer.
        vm.warp(DOC_CANCEL_DEADLINE);
        vm.expectEmit(true, true, true, true, EXAMPLE_CONTRACT);
        emit IPayLinkV2.InvoiceCancelled(DOC_KEY, EXAMPLE_PAYEE);
        vm.prank(relayer);
        example.cancelBySig(_exampleInvoice(), DOC_CANCEL_DEADLINE, DOC_CANCEL_SIGNATURE);
        assertTrue(example.stateOf(DOC_KEY).cancelled);
    }
}
