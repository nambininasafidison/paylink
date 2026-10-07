// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {Wallet1271} from "../mocks/Wallet1271.sol";
import {Wallet1271Gas} from "../mocks/Wallet1271Gas.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Payee signature handling: ECDSA (low-s, 65 bytes only), deployed ERC-1271 accounts, hostile accounts.
contract SignaturesTest is BaseTest {
    bytes32 internal constant REF = bytes32("SIG");

    IPayLinkV2.Invoice internal inv;
    bytes32 internal key;

    function setUp() public override {
        super.setUp();
        inv = _invoiceN(address(0), 1 ether, 0);
        key = _key(inv);
    }

    function _payNative(bytes memory sig) internal {
        vm.prank(payer);
        payLink.payNative{value: 1 ether}(inv, sig, REF);
    }

    function _expectInvalidSignature(bytes memory sig) internal {
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payNative{value: 1 ether}(inv, sig, REF);
    }

    // ------------------------------------------------------------------ ECDSA

    function test_EcdsaLowSAccepted() public {
        bytes memory sig = _sign(payeeKey, key);
        (, bytes32 s,) = _split(sig);
        assertLe(uint256(s), SECP256K1_N / 2, "vm.sign is canonical");
        _payNative(sig);
    }

    /// @notice The malleated twin (r, n - s, v ^ 1) recovers the same signer through raw ecrecover, but OZ ECDSA
    ///         rejects s > n/2.
    function test_RevertWhen_HighS() public {
        bytes memory high = _highS(_sign(payeeKey, key));
        (bytes32 r, bytes32 s, uint8 v) = _split(high);
        assertEq(ecrecover(key, v, r, s), payee, "precondition: raw ecrecover accepts it");
        _expectInvalidSignature(high);
    }

    /// @notice EIP-2098 compact (64-byte) signatures are not accepted (OZ 5 removed them from `tryRecover(bytes)`).
    function test_RevertWhen_CompactSignature() public {
        (bytes32 r, bytes32 s, uint8 v) = _split(_sign(payeeKey, key));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        _expectInvalidSignature(abi.encodePacked(r, vs));
    }

    function test_RevertWhen_SignatureTooLong() public {
        _expectInvalidSignature(abi.encodePacked(_sign(payeeKey, key), bytes1(0)));
    }

    function test_RevertWhen_InvalidV() public {
        (bytes32 r, bytes32 s,) = _split(_sign(payeeKey, key));
        _expectInvalidSignature(abi.encodePacked(r, s, uint8(29)));
    }

    function test_RevertWhen_ZeroSignature() public {
        _expectInvalidSignature(new bytes(65));
    }

    /// @notice A signature over the raw struct hash (no EIP-712 envelope) or an eth_sign message is not valid.
    function test_RevertWhen_SignedWithoutTypedDataEnvelope() public {
        _expectInvalidSignature(_sign(payeeKey, _structHash(inv)));
        _expectInvalidSignature(_sign(payeeKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", key))));
    }

    // ------------------------------------------------------------------ ERC-1271

    function test_Erc1271PayeeWithOwnerSignature() public {
        Wallet1271 wallet = new Wallet1271(payee);
        inv.payee = address(wallet);
        key = _key(inv);
        _payNative(_sign(payeeKey, key));
        assertEq(address(wallet).balance, 1 ether);
    }

    function test_Erc1271PayeeWithPreApprovedHash() public {
        Wallet1271 wallet = new Wallet1271(payee);
        inv.payee = address(wallet);
        key = _key(inv);
        vm.prank(payee);
        wallet.approveHash(key, true);
        _payNative("");
        assertEq(address(wallet).balance, 1 ether);
    }

    /// @notice Spec §5 threat 12: the signature is checked on every payment, so a contract payee that rotates its
    ///         key (or revokes approval) stops further payments; no "skip after first payment".
    function test_Erc1271PayeeCanRevokeByRotatingOwner() public {
        Wallet1271 wallet = new Wallet1271(payee);
        inv.payee = address(wallet);
        key = _key(inv);
        bytes memory sig = _sign(payeeKey, key);
        _payNative(sig);

        vm.prank(payee);
        wallet.setOwner(stranger);
        _expectInvalidSignature(sig);
    }

    /// @notice Spec §5 threat 12: an undeployed (counterfactual) smart account cannot be a payee, because a
    ///         code-less address is checked with ECDSA and nobody holds its key.
    function test_RevertWhen_PayeeIsUndeployedSmartAccount() public {
        address counterfactual = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        inv.payee = counterfactual;
        key = _key(inv);
        bytes memory ownerSig = _sign(payeeKey, key);
        _expectInvalidSignature(ownerSig);

        // Once deployed at that address, the same owner signature verifies through ERC-1271.
        Wallet1271 wallet = new Wallet1271(payee);
        assertEq(address(wallet), counterfactual);
        _payNative(ownerSig);
    }

    function test_RevertWhen_EcdsaSignatureOfAnEoaForContractPayee() public {
        Wallet1271 wallet = new Wallet1271(payee);
        inv.payee = address(wallet);
        key = _key(inv);
        _expectInvalidSignature(_sign(strangerKey, key));
    }

    // ------------------------------------------------------------------ hostile ERC-1271 (spec §5 threat 13)

    function test_RevertWhen_Erc1271BurnsAllGas() public {
        Wallet1271Gas hostile = new Wallet1271Gas(Wallet1271Gas.Mode.BurnAllGas);
        inv.payee = address(hostile);
        vm.prank(payer);
        vm.expectRevert(IPayLinkV2.InvalidSignature.selector);
        payLink.payNative{value: 1 ether, gas: 1_000_000}(inv, "", REF);
    }

    function test_RevertWhen_Erc1271ReturnsWrongMagic() public {
        Wallet1271Gas hostile = new Wallet1271Gas(Wallet1271Gas.Mode.WrongMagic);
        inv.payee = address(hostile);
        _expectInvalidSignature("");
    }

    function test_RevertWhen_Erc1271ReturnsShortData() public {
        Wallet1271Gas hostile = new Wallet1271Gas(Wallet1271Gas.Mode.ShortReturn);
        inv.payee = address(hostile);
        _expectInvalidSignature("");
    }

    function test_RevertWhen_Erc1271Reverts() public {
        Wallet1271Gas hostile = new Wallet1271Gas(Wallet1271Gas.Mode.Revert);
        inv.payee = address(hostile);
        _expectInvalidSignature("");
    }

    /// @notice A return bomb that starts with the magic value is accepted (the payee chose to accept) but costs the
    ///         caller memory expansion; it only affects payments to that payee and is bounded by the gas limit.
    function test_Erc1271ReturnBombOnlyCostsItsOwnPayers() public {
        Wallet1271Gas hostile = new Wallet1271Gas(Wallet1271Gas.Mode.ReturnBomb);
        inv.payee = address(hostile);

        vm.prank(payer);
        uint256 gasBefore = gasleft();
        payLink.payNative{value: 1 ether}(inv, "", REF);
        uint256 used = gasBefore - gasleft();
        assertGt(used, 100_000, "the bomb is paid for by this payment");

        // With a tight gas limit the payment simply fails; other links are unaffected.
        vm.prank(payer);
        vm.expectRevert();
        payLink.payNative{value: 1 ether, gas: 60_000}(inv, "", REF);

        IPayLinkV2.Invoice memory normal = _invoice(address(0), 1 ether);
        bytes memory normalSig = _signInvoice(normal);
        vm.prank(payer);
        payLink.payNative{value: 1 ether, gas: 150_000}(normal, normalSig, REF);
    }
}
