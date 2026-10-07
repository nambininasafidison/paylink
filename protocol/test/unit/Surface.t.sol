// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {Donor} from "../mocks/Donor.sol";
import {OpcodeScanner} from "../toolchain/OpcodeScanner.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Contract surface: receive/fallback, no admin functions, deployable bytecode properties.
contract SurfaceTest is BaseTest {
    // ------------------------------------------------------------------ receive / fallback (I10)

    function test_RevertWhen_PlainNativeTransfer() public {
        vm.prank(payer);
        (bool ok, bytes memory ret) = address(payLink).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IPayLinkV2.WrongPaymentPath.selector));
    }

    function test_RevertWhen_NativeTransferViaTransfer() public {
        Donor donor = new Donor();
        (bool ok, bytes memory ret) = donor.tryDonateNative{value: 1 ether}(address(payLink));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IPayLinkV2.WrongPaymentPath.selector));
        assertEq(address(payLink).balance, 0);
    }

    function test_RevertWhen_UnknownSelector() public {
        (bool ok, bytes memory ret) = address(payLink).call(hex"deadbeef");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IPayLinkV2.WrongPaymentPath.selector));
    }

    function test_RevertWhen_UnknownSelectorWithValue() public {
        vm.prank(payer);
        (bool ok, bytes memory ret) = address(payLink).call{value: 1}(hex"deadbeef00");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IPayLinkV2.WrongPaymentPath.selector));
    }

    /// @notice Ownerless, pause-less, sweep-less: the usual admin selectors do not exist.
    function test_NoAdminSurface() public {
        bytes[9] memory calls = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("transferOwnership(address)", stranger),
            abi.encodeWithSignature("pause()"),
            abi.encodeWithSignature("paused()"),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", stranger, ""),
            abi.encodeWithSignature("sweep(address,address)", address(usdc), stranger),
            abi.encodeWithSignature("withdraw(address)", stranger),
            abi.encodeWithSignature("setFee(uint256)", 1),
            abi.encodeWithSignature("multicall(bytes[])", new bytes[](0))
        ];
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = address(payLink).call(calls[i]);
            assertFalse(ok);
            assertEq(ret, abi.encodeWithSelector(IPayLinkV2.WrongPaymentPath.selector));
        }
    }

    function test_PayableEntryPointIsOnlyPayNative() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        bytes memory sig = _signInvoice(inv);
        // Non-payable entry points reject value at the ABI layer (empty revert data).
        vm.prank(payer);
        (bool ok,) = address(payLink).call{value: 1}(abi.encodeCall(payLink.pay, (inv, sig, USDC_25, "")));
        assertFalse(ok);
        vm.prank(payer);
        (ok,) = address(payLink).call{value: 1}(abi.encodeCall(payLink.cancel, (inv)));
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ bytecode (spec §3.3.5, §3.3.7)

    function test_RuntimeHasNoPostParisOpcodes() public view {
        bytes memory runtime = address(payLink).code;
        (bool found, uint256 pc, uint8 op) =
            OpcodeScanner.findFirst(runtime, 0, OpcodeScanner.executableEnd(runtime), OpcodeScanner.POST_PARIS_OPCODES);
        assertFalse(found, string.concat("opcode ", vm.toString(abi.encodePacked(op)), " at ", vm.toString(pc)));
    }

    function test_InitCodeHasNoPostParisOpcodes() public view {
        bytes memory creation = type(PayLinkV2).creationCode;
        uint256 initLength = creation.length - address(payLink).code.length;
        (bool found,,) = OpcodeScanner.findFirst(creation, 0, initLength, OpcodeScanner.POST_PARIS_OPCODES);
        assertFalse(found);
    }

    function test_CompiledBySolc0830() public view {
        (bytes3 version, bool present) = OpcodeScanner.solcVersion(address(payLink).code);
        assertTrue(present);
        assertEq(version, bytes3(0x00081e));
    }

    function test_FitsEip170() public view {
        assertLe(address(payLink).code.length, 24_576);
    }

    function test_ConstructorTakesNoArgumentsSoInitCodeIsChainIndependent() public {
        bytes32 here = keccak256(type(PayLinkV2).creationCode);
        vm.chainId(10_143);
        assertEq(keccak256(type(PayLinkV2).creationCode), here);
        // And a deployment on another chain id only differs in its immutables.
        PayLinkV2 monad = new PayLinkV2();
        assertEq(address(monad).code.length, address(payLink).code.length);
    }
}
