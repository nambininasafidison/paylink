// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice I7 domain separation: a payee or cancel signature for (chainId, verifyingContract) A never verifies under
///         B. Fuzzed over `vm.chainId` and alternate deployments (CREATE2 salts and arbitrary addresses).
contract DomainFuzzTest is BaseTest {
    /// @dev EIP-2294 upper bound on chain ids.
    uint256 internal constant MAX_CHAIN_ID = type(uint64).max / 2 - 36;

    function testFuzz_I7_InvoiceSignatureBoundToChainId(uint256 chainA, uint256 chainB) public {
        chainA = bound(chainA, 1, MAX_CHAIN_ID);
        chainB = bound(chainB, 1, MAX_CHAIN_ID);
        vm.assume(chainA != chainB);

        vm.chainId(chainA);
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 1 ether, 0);
        bytes memory sigA = _signInvoice(inv);
        bytes32 keyA = payLink.invoiceKey(inv);
        assertEq(keyA, _keyFor(inv, chainA, address(payLink)), "key commits to chainA");

        vm.chainId(chainB);
        assertTrue(payLink.invoiceKey(inv) != keyA, "key changes with chainId");
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payNative{value: 1 ether}(inv, sigA, "");

        vm.chainId(chainA);
        vm.prank(payer);
        payLink.payNative{value: 1 ether}(inv, sigA, "");
    }

    function testFuzz_I7_InvoiceSignatureBoundToDeployment(bytes32 salt) public {
        PayLinkV2 other = new PayLinkV2{salt: salt}();
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 1 ether, 0);
        bytes memory sigMain = _signInvoice(inv);
        bytes memory sigOther = _sign(payeeKey, _keyFor(inv, vm.getChainId(), address(other)));

        vm.startPrank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        other.payNative{value: 1 ether}(inv, sigMain, "");
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payNative{value: 1 ether}(inv, sigOther, "");
        other.payNative{value: 1 ether}(inv, sigOther, "");
        payLink.payNative{value: 1 ether}(inv, sigMain, "");
        vm.stopPrank();
        // Same invoice, two deployments: two independent links.
        assertEq(payLink.stateOf(_key(inv)).payments, 1);
        assertEq(other.stateOf(_keyFor(inv, vm.getChainId(), address(other))).payments, 1);
    }

    /// @notice The key equals the reference EIP-712 digest for any chain id and any deployment address.
    function testFuzz_I7_KeyMatchesReferenceAnywhere(uint256 chainId, address at, IPayLinkV2.Invoice memory inv)
        public
    {
        chainId = bound(chainId, 1, MAX_CHAIN_ID);
        vm.assume(uint160(at) > 0xffff && at.code.length == 0 && at != address(vm) && at != CONSOLE);
        vm.chainId(chainId);
        deployCodeTo("PayLinkV2.sol:PayLinkV2", at);
        assertEq(PayLinkV2(payable(at)).invoiceKey(inv), _keyFor(inv, chainId, at));
        (,,, uint256 domainChainId, address verifyingContract,,) = PayLinkV2(payable(at)).eip712Domain();
        assertEq(domainChainId, chainId);
        assertEq(verifyingContract, at);
    }

    function testFuzz_I7_CancelSignatureBoundToDomain(uint256 chainB, bytes32 salt) public {
        chainB = bound(chainB, 1, MAX_CHAIN_ID);
        vm.assume(chainB != vm.getChainId());
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        uint256 deadline = vm.getBlockTimestamp() + 1 days;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);

        PayLinkV2 other = new PayLinkV2{salt: salt}();
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        other.cancelBySig(inv, deadline, cancelSig);

        uint256 chainA = vm.getChainId();
        vm.chainId(chainB);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(inv, deadline, cancelSig);

        vm.chainId(chainA);
        payLink.cancelBySig(inv, deadline, cancelSig);
        assertTrue(payLink.stateOf(_key(inv)).cancelled);
    }

    /// @notice A cancellation is local to its domain: cancelling on one chain id leaves the same invoice payable on
    ///         another (where it has another key), so cross-chain state never leaks either.
    function testFuzz_I7_StateIsPerDomain(uint256 chainB) public {
        chainB = bound(chainB, 1, MAX_CHAIN_ID);
        vm.assume(chainB != vm.getChainId());
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 1 ether, 0);
        vm.prank(payee);
        payLink.cancel(inv);

        vm.chainId(chainB);
        bytes memory sigB = _signInvoice(inv);
        vm.prank(payer);
        payLink.payNative{value: 1 ether}(inv, sigB, "");
        assertEq(payLink.stateOf(_key(inv)).payments, 1);
        assertFalse(payLink.stateOf(_key(inv)).cancelled);
    }
}
