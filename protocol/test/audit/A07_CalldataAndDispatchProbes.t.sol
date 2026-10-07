// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @title A-07 probes: calldata encoding and signer dispatch (attacks that must fail)
/// @notice Regression evidence for vectors not pinned elsewhere. Each test is an attack attempt that the contract
///         withstands today.
///         1. Key aliasing through non-canonical calldata: if `uint128`/`uint64`/`uint32`/`address` fields with dirty
///            high-order bits were silently masked, two different calldatas would map to one key, and if they were
///            hashed unmasked, a relayer could make an honest call revert by re-encoding it. Solidity's ABI decoder
///            must revert instead, on every entry point that takes an `Invoice`.
///         2. PayLink as a signer: tokens that dispatch to ERC-1271 for signers with code (FiatToken v2.2, AUSD via
///            Solady) would let a `from = PayLink` authorization through if PayLink answered `isValidSignature`.
///            Its fallback must refuse that call, also under STATICCALL.
/// @dev Run: forge test --match-path 'test/audit/A07_CalldataAndDispatchProbes.t.sol' -vv
contract A07CalldataAndDispatchProbesTest is BaseTest {
    /// @dev Word index of each `Invoice` field in `f(Invoice)` calldata (the struct is static, so it is inline).
    uint256 internal constant W_PAYEE = 0;
    uint256 internal constant W_TOKEN = 1;
    uint256 internal constant W_AMOUNT = 2;
    uint256 internal constant W_VALID_AFTER = 3;
    uint256 internal constant W_VALID_UNTIL = 4;
    uint256 internal constant W_MAX_PAYMENTS = 5;

    function _dirty(bytes memory data, uint256 word, uint256 bit) internal pure returns (bytes memory) {
        uint256 offset = 4 + 32 * word;
        uint256 value;
        assembly ("memory-safe") {
            value := mload(add(add(data, 0x20), offset))
        }
        value |= uint256(1) << bit;
        assembly ("memory-safe") {
            mstore(add(add(data, 0x20), offset), value)
        }
        return data;
    }

    /// @notice Every narrow field, with one bit set just above its width, makes `invoiceKey` revert: no aliasing.
    function test_DirtyHighBits_InvoiceKeyReverts() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        bytes memory clean = abi.encodeCall(payLink.invoiceKey, (inv));
        (bool ok, bytes memory ret) = address(payLink).staticcall(clean);
        assertTrue(ok, "clean calldata");
        assertEq(abi.decode(ret, (bytes32)), _key(inv));

        uint256[6] memory words = [W_PAYEE, W_TOKEN, W_AMOUNT, W_VALID_AFTER, W_VALID_UNTIL, W_MAX_PAYMENTS];
        uint256[6] memory widths = [uint256(160), 160, 128, 64, 64, 32];
        for (uint256 i = 0; i < words.length; ++i) {
            (ok,) = address(payLink).staticcall(_dirty(abi.encodeCall(payLink.invoiceKey, (inv)), words[i], widths[i]));
            assertFalse(ok, "dirty high bits must revert");
        }
    }

    /// @notice Same on a settlement entry point: a re-encoded `pay` with a dirty `amount` reverts before any effect.
    function test_DirtyHighBits_PayReverts() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(musd), 25e18);
        bytes memory sig = _signInvoice(inv);
        vm.prank(payer);
        musd.approve(address(payLink), 25e18);
        bytes memory data =
            _dirty(abi.encodeCall(payLink.pay, (inv, sig, uint128(25e18), bytes32("A07"))), W_AMOUNT, 128);
        vm.prank(payer);
        (bool ok,) = address(payLink).call(data);
        assertFalse(ok, "dirty invoice amount must revert");
        assertEq(payLink.stateOf(_key(inv)).payments, 0);
        assertEq(musd.balanceOf(payee), 0);
    }

    /// @notice PayLink never answers ERC-1271, neither by CALL nor by STATICCALL, so no token that dispatches to
    ///         ERC-1271 for signers with code can accept an authorization or permit "signed" by PayLink.
    function test_PayLinkIsNeverAnErc1271Signer() public {
        bytes memory data = abi.encodeCall(IERC1271.isValidSignature, (bytes32(uint256(1)), ""));
        (bool ok, bytes memory ret) = address(payLink).staticcall(data);
        assertFalse(ok, "staticcall must revert");
        assertEq(ret, abi.encodeWithSelector(IPayLinkV2.WrongPaymentPath.selector));
        (ok,) = address(payLink).call(data);
        assertFalse(ok, "call must revert");
    }
}
