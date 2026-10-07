// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice `invoiceKey`, `paymentNonce`, `stateOf`, `statesOf`, the public type hashes and ERC-5267.
contract ViewsTest is BaseTest {
    function test_TypeHashesMatchTheSpecStrings() public view {
        assertEq(
            payLink.INVOICE_TYPEHASH(),
            keccak256(
                "Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)"
            )
        );
        assertEq(payLink.CANCEL_TYPEHASH(), keccak256("Cancel(bytes32 key,uint256 deadline)"));
        assertEq(
            payLink.PAYMENT_BINDING_TYPEHASH(),
            keccak256("PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)")
        );
    }

    function test_Eip712DomainIsErc5267() public view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = payLink.eip712Domain();
        assertEq(fields, hex"0f", "name, version, chainId, verifyingContract");
        assertEq(name, "PayLink");
        assertEq(version, "2");
        assertEq(chainId, vm.getChainId());
        assertEq(verifyingContract, address(payLink));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
    }

    function test_Eip712DomainFollowsChainId() public {
        vm.chainId(10_143);
        (,,, uint256 chainId,,,) = payLink.eip712Domain();
        assertEq(chainId, 10_143);
    }

    function test_InvoiceKeyMatchesReferenceImplementation() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        assertEq(payLink.invoiceKey(inv), _keyFor(inv, vm.getChainId(), address(payLink)));
    }

    function test_InvoiceKeyCoversEveryField() public {
        IPayLinkV2.Invoice memory base = _invoice(address(usdc), USDC_25);
        bytes32 k = payLink.invoiceKey(base);
        IPayLinkV2.Invoice memory m;

        m = _clone(base);
        m.payee = stranger;
        assertTrue(payLink.invoiceKey(m) != k, "payee");
        m = _clone(base);
        m.token = address(musd);
        assertTrue(payLink.invoiceKey(m) != k, "token");
        m = _clone(base);
        m.amount += 1;
        assertTrue(payLink.invoiceKey(m) != k, "amount");
        m = _clone(base);
        m.validAfter += 1;
        assertTrue(payLink.invoiceKey(m) != k, "validAfter");
        m = _clone(base);
        m.validUntil += 1;
        assertTrue(payLink.invoiceKey(m) != k, "validUntil");
        m = _clone(base);
        m.maxPayments += 1;
        assertTrue(payLink.invoiceKey(m) != k, "maxPayments");
        m = _clone(base);
        m.salt = bytes32(uint256(m.salt) ^ 1);
        assertTrue(payLink.invoiceKey(m) != k, "salt");
        m = _clone(base);
        m.memoHash = bytes32(0);
        assertTrue(payLink.invoiceKey(m) != k, "memoHash");
    }

    function test_InvoiceKeyDoesNotValidateShape() public view {
        IPayLinkV2.Invoice memory inv; // all zero: unpayable, but still hashable for tooling
        assertEq(payLink.invoiceKey(inv), _keyFor(inv, vm.getChainId(), address(payLink)));
    }

    function test_PaymentNonceMatchesSpecFormula() public view {
        bytes32 key = keccak256("key");
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)"
                ),
                key,
                payer,
                uint128(25e6),
                bytes32("ref"),
                bytes32("salt")
            )
        );
        assertEq(payLink.paymentNonce(key, payer, 25e6, "ref", "salt"), expected);
    }

    function test_StateOfUnknownKeyIsZero() public view {
        _assertState(keccak256("unknown"), 0, false, 0, 0);
    }

    function test_StatesOfPreservesOrderAndDuplicates() public {
        IPayLinkV2.Invoice memory a = _invoiceN(address(musd), 0, 0);
        IPayLinkV2.Invoice memory b = _invoice(address(musd), 0);
        bytes memory sigA = _signInvoice(a);
        vm.startPrank(payer);
        musd.approve(address(payLink), type(uint256).max);
        payLink.pay(a, sigA, 5, "");
        payLink.pay(a, sigA, 7, "");
        vm.stopPrank();
        vm.prank(payee);
        payLink.cancel(b);

        bytes32[] memory keys = new bytes32[](4);
        keys[0] = _key(b);
        keys[1] = _key(a);
        keys[2] = keccak256("unknown");
        keys[3] = _key(a);
        IPayLinkV2.LinkState[] memory states = payLink.statesOf(keys);

        assertEq(states.length, 4);
        assertTrue(states[0].cancelled);
        assertEq(states[0].payments, 0);
        assertEq(states[1].payments, 2);
        assertEq(states[1].total, 12);
        assertEq(states[1].lastPaidAt, vm.getBlockTimestamp());
        assertEq(states[2].payments, 0);
        assertFalse(states[2].cancelled);
        assertEq(abi.encode(states[3]), abi.encode(states[1]));
    }

    function test_StatesOfEmpty() public view {
        assertEq(payLink.statesOf(new bytes32[](0)).length, 0);
    }

    function test_StatesOfAcceptsMaxBatch() public view {
        assertEq(payLink.statesOf(new bytes32[](256)).length, 256);
    }

    function test_RevertWhen_StatesOfBatchTooLarge() public {
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.BatchTooLarge.selector, uint256(256)));
        payLink.statesOf(new bytes32[](257));
    }
}
