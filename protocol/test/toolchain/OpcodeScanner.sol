// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title OpcodeScanner
/// @notice Walks legacy EVM bytecode instruction by instruction to prove a build
///         contains no opcode the target fork cannot execute.
/// @dev PayLinkV2 ships one paris artifact to every chain, Mezo included
///      (London-level). See spec §3.3.5 and docs/adr/0012. Reuse this library
///      for any deployable contract: scan its runtime with `executableEnd` and
///      its init code with `creation.length - runtime.length`.
library OpcodeScanner {
    /// @notice Bit set of the opcodes added after Paris. Bit `i` is set when opcode `i` is forbidden.
    /// @dev PUSH0 0x5f (Shanghai, EIP-3855); TLOAD 0x5c, TSTORE 0x5d (Cancun, EIP-1153);
    ///      MCOPY 0x5e (Cancun, EIP-5656); BLOBHASH 0x49 (Cancun, EIP-4844);
    ///      BLOBBASEFEE 0x4a (Cancun, EIP-7516); CLZ 0x1e (Osaka, EIP-7939).
    uint256 internal constant POST_PARIS_OPCODES = (uint256(1) << 0x5f) | (uint256(1) << 0x5c) | (uint256(1) << 0x5d)
        | (uint256(1) << 0x5e) | (uint256(1) << 0x49) | (uint256(1) << 0x4a) | (uint256(1) << 0x1e);

    uint8 private constant PUSH1 = 0x60;
    uint8 private constant PUSH32 = 0x7f;

    /// @notice Thrown when the trailing CBOR length does not fit inside the code.
    error MalformedMetadata(uint256 codeLength, uint256 metadataLength);

    /// @notice Returns the end of the executable part of solc runtime code, before the CBOR
    ///         metadata and its 2-byte big-endian length suffix.
    function executableEnd(bytes memory runtime) internal pure returns (uint256) {
        uint256 n = runtime.length;
        if (n < 2) revert MalformedMetadata(n, 0);
        uint256 metadataLength = (uint256(uint8(runtime[n - 2])) << 8) | uint256(uint8(runtime[n - 1]));
        if (metadataLength + 2 > n) revert MalformedMetadata(n, metadataLength);
        return n - 2 - metadataLength;
    }

    /// @notice Returns the 3-byte compiler version (major, minor, patch) that solc stores at the
    ///         end of the CBOR metadata under the "solc" key.
    /// @dev The metadata ends with 0x64 "solc" 0x43 <major> <minor> <patch>, then the length suffix.
    function solcVersion(bytes memory runtime) internal pure returns (bytes3 version, bool present) {
        uint256 n = runtime.length;
        if (n < 11) return (bytes3(0), false);
        // 0x64 's' 'o' 'l' 'c' 0x43
        bytes6 marker = bytes6(0x64736f6c6343);
        bytes6 found;
        for (uint256 i = 0; i < 6; ++i) {
            found |= bytes6(runtime[n - 11 + i]) >> (8 * i);
        }
        if (found != marker) return (bytes3(0), false);
        version = bytes3(runtime[n - 5]) | (bytes3(runtime[n - 4]) >> 8) | (bytes3(runtime[n - 3]) >> 16);
        return (version, true);
    }

    /// @notice Finds the first opcode in `code[start:end]` that is in `forbidden`. Skips PUSH1..PUSH32
    ///         immediates, so data bytes are never mistaken for instructions.
    function findFirst(bytes memory code, uint256 start, uint256 end, uint256 forbidden)
        internal
        pure
        returns (bool found, uint256 pc, uint8 opcode)
    {
        for (uint256 i = start; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if ((forbidden >> op) & 1 == 1) return (true, i, op);
            if (op >= PUSH1 && op <= PUSH32) i += op - PUSH1 + 1;
        }
        return (false, 0, 0);
    }
}
