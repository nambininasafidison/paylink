// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice I8 binding: an EIP-3009 authorization for (key, payer, amount, payerRef, payerSalt) never settles a
///         different tuple; the token rejects the signature. Signature hygiene fuzzing for payee signatures.
contract BindingFuzzTest is BaseTest {
    IPayLinkV2.Invoice internal inv;
    bytes internal sig;
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        inv = _invoiceN(address(usdc), 0, 0); // open, unlimited: only the binding can stop a mutated tuple
        sig = _signInvoice(inv);
        key = _key(inv);
    }

    function testFuzz_I8_MutatedTupleNeverSettles(
        uint128 amount,
        bytes32 payerRef,
        bytes32 payerSalt,
        uint8 field,
        bytes32 mutation
    ) public {
        amount = uint128(bound(amount, 1, 1_000_000e6));
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, amount, payerRef, payerSalt);
        IPayLinkV2.Authorization memory forged = _clone(auth);
        IPayLinkV2.Invoice memory target = _clone(inv);
        bytes memory targetSig = sig;

        field = field % 5;
        if (field == 0) {
            forged.amount = uint128(bound(uint256(mutation), 1, 1_000_000e6));
            vm.assume(forged.amount != amount);
        } else if (field == 1) {
            vm.assume(mutation != payerRef);
            forged.payerRef = mutation;
        } else if (field == 2) {
            vm.assume(mutation != payerSalt);
            forged.payerSalt = mutation;
        } else if (field == 3) {
            // Another link of the same payee (the relayer picks a different invoice).
            target.salt = mutation;
            vm.assume(mutation != inv.salt);
            targetSig = _signInvoice(target);
        } else {
            // Another payer: the relayer tries to debit someone else with this signature.
            forged.payer = address(uint160(uint256(mutation)));
            vm.assume(forged.payer != payer && forged.payer != payee && forged.payer != address(0));
            usdc.mint(forged.payer, 1_000_000e6);
        }

        uint256 payeeBefore = usdc.balanceOf(payee);
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        payLink.payWithAuthorization(target, targetSig, forged);
        assertEq(usdc.balanceOf(payee), payeeBefore, "nothing moved");

        // The honest tuple still settles, exactly once.
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, auth);
        assertEq(usdc.balanceOf(payee) - payeeBefore, amount);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    function testFuzz_I8_NonceIsInjective(
        bytes32[2] calldata keys,
        address[2] calldata payers,
        uint128[2] calldata amounts,
        bytes32[2] calldata refs,
        bytes32[2] calldata salts
    ) public view {
        bool same = keys[0] == keys[1] && payers[0] == payers[1] && amounts[0] == amounts[1] && refs[0] == refs[1]
            && salts[0] == salts[1];
        bytes32 n0 = payLink.paymentNonce(keys[0], payers[0], amounts[0], refs[0], salts[0]);
        bytes32 n1 = payLink.paymentNonce(keys[1], payers[1], amounts[1], refs[1], salts[1]);
        assertEq(n0 == n1, same);
        assertEq(n0, _nonce(keys[0], payers[0], amounts[0], refs[0], salts[0]));
    }

    // ------------------------------------------------------------------ payee signature hygiene

    function testFuzz_RandomBytesNeverVerify(bytes calldata garbage) public {
        IPayLinkV2.Invoice memory native = _invoiceN(address(0), 1, 0);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payNative{value: 1}(native, garbage, "");
    }

    function testFuzz_OtherSignerNeverVerifies(uint256 signerKey) public {
        signerKey = bound(signerKey, 1, SECP256K1_N - 1);
        vm.assume(signerKey != payeeKey);
        IPayLinkV2.Invoice memory native = _invoiceN(address(0), 1, 0);
        bytes memory forged = _sign(signerKey, _key(native));
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payNative{value: 1}(native, forged, "");
    }

    function testFuzz_HighSNeverVerifies(bytes32 salt) public {
        IPayLinkV2.Invoice memory native = _invoiceN(address(0), 1, 0);
        native.salt = salt;
        bytes memory high = _highS(_signInvoice(native));
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payNative{value: 1}(native, high, "");
        vm.prank(payee);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.cancelBySig(
            native, vm.getBlockTimestamp(), _highS(_signCancel(payeeKey, native, vm.getBlockTimestamp()))
        );
    }
}
