// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Test} from "forge-std/Test.sol";

import {OpcodeScanner} from "./OpcodeScanner.sol";

/// @notice Uses every OpenZeppelin module that PayLinkV2 may import (spec §3.3.1: EIP712,
///         SignatureChecker, ECDSA, SafeERC20, ReentrancyGuard, Address), so their code is in
///         the bytecode the scanner checks.
contract OzSurfaceProbe is EIP712("PayLink", "2"), ReentrancyGuard {
    using SafeERC20 for IERC20;

    function verify(address signer, bytes32 structHash, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(structHash), signature);
    }

    function recover(bytes32 digest, bytes calldata signature) external pure returns (address) {
        return ECDSA.recover(digest, signature);
    }

    function pull(IERC20 token, address from, address to, uint256 value) external nonReentrant {
        token.safeTransferFrom(from, to, value);
    }

    function push(IERC20 token, address to, uint256 value) external nonReentrant {
        token.safeTransfer(to, value);
    }

    function forward(address payable to) external payable nonReentrant {
        Address.sendValue(to, msg.value);
    }
}

/// @title Toolchain canary: compiler pin and EVM target
/// @notice Fails the build gate if the toolchain drifts from ADR 0002 and spec §3.3.5:
///         a solc other than 0.8.30, an evm_version later than paris, or an OpenZeppelin
///         release that emits post-paris opcodes (OZ >= 5.4 emits MCOPY).
contract EvmTargetTest is Test {
    OzSurfaceProbe internal probe;

    function setUp() public {
        probe = new OzSurfaceProbe();
    }

    function test_RuntimeIsCompiledBySolc0830() public view {
        (bytes3 version, bool present) = OpcodeScanner.solcVersion(address(probe).code);
        assertTrue(present, "CBOR metadata has no solc version (cbor_metadata disabled?)");
        assertEq(version, bytes3(0x00081e), "runtime was not compiled by solc 0.8.30");
    }

    function test_RuntimeHasNoPostParisOpcodes() public view {
        bytes memory runtime = address(probe).code;
        _assertParisOnly(runtime, 0, OpcodeScanner.executableEnd(runtime), "runtime");
    }

    function test_InitCodeHasNoPostParisOpcodes() public view {
        bytes memory creation = type(OzSurfaceProbe).creationCode;
        uint256 runtimeLength = address(probe).code.length;
        assertGt(creation.length, runtimeLength, "creation code must embed the runtime");
        // Init code precedes the embedded runtime; the runtime itself is covered above.
        _assertParisOnly(creation, 0, creation.length - runtimeLength, "init code");
    }

    // ------------------------------------------------------------ scanner self-tests (negative controls)

    function test_ScannerFlagsEachPostParisOpcode() public pure {
        uint8[7] memory forbidden = [0x5f, 0x5c, 0x5d, 0x5e, 0x49, 0x4a, 0x1e];
        for (uint256 i = 0; i < forbidden.length; ++i) {
            // JUMPDEST, <forbidden>, STOP
            bytes memory code = abi.encodePacked(uint8(0x5b), forbidden[i], uint8(0x00));
            (bool found, uint256 pc, uint8 opcode) =
                OpcodeScanner.findFirst(code, 0, code.length, OpcodeScanner.POST_PARIS_OPCODES);
            assertTrue(found, "forbidden opcode not detected");
            assertEq(pc, 1, "wrong program counter");
            assertEq(opcode, forbidden[i], "wrong opcode reported");
        }
    }

    function test_ScannerAllowsParisOpcodes() public pure {
        // PUSH1 0x80 PUSH1 0x40 MSTORE CALLVALUE DUP1 ISZERO PUSH2 0x0010 JUMPI CHAINID BASEFEE PREVRANDAO STOP
        bytes memory code = hex"6080604052348015610010574648440000";
        (bool found,,) = OpcodeScanner.findFirst(code, 0, code.length, OpcodeScanner.POST_PARIS_OPCODES);
        assertFalse(found, "paris opcode wrongly flagged");
    }

    function testFuzz_ScannerSkipsPushImmediates(bytes32 data, uint8 width) public pure {
        uint256 n = bound(width, 1, 32);
        // PUSHn <n bytes of arbitrary data, possibly forbidden opcode values>, STOP
        bytes memory code = abi.encodePacked(uint8(0x5f + n), _prefix(data, n), uint8(0x00));
        (bool found,,) = OpcodeScanner.findFirst(code, 0, code.length, OpcodeScanner.POST_PARIS_OPCODES);
        assertFalse(found, "PUSH immediate data was decoded as an opcode");
    }

    function test_ExecutableEndStripsMetadata() public pure {
        // STOP, then 3 metadata bytes, then length suffix 0x0003
        bytes memory code = hex"00aabbcc0003";
        assertEq(OpcodeScanner.executableEnd(code), 1);
    }

    function test_RevertWhen_MetadataLengthOverflowsCode() public {
        bytes memory code = hex"00ffff";
        vm.expectRevert(abi.encodeWithSelector(OpcodeScanner.MalformedMetadata.selector, 3, 0xffff));
        this.executableEndExternal(code);
    }

    /// @dev External wrapper so vm.expectRevert can observe the library revert at a call boundary.
    function executableEndExternal(bytes memory code) external pure returns (uint256) {
        return OpcodeScanner.executableEnd(code);
    }

    // ------------------------------------------------------------ helpers

    function _assertParisOnly(bytes memory code, uint256 start, uint256 end, string memory label) internal pure {
        (bool found, uint256 pc, uint8 opcode) =
            OpcodeScanner.findFirst(code, start, end, OpcodeScanner.POST_PARIS_OPCODES);
        assertFalse(
            found,
            string.concat(
                label, ": post-paris opcode ", vm.toString(abi.encodePacked(opcode)), " at pc ", vm.toString(pc)
            )
        );
    }

    function _prefix(bytes32 data, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = data[i];
        }
    }
}
