// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Json: deterministic JSON writer for scripts and test fixtures
/// @notice Builds documents with a fixed key order and two-space indentation, so generated files (deployment
///         records, golden vectors) are byte-for-byte reproducible and diff cleanly. Foundry's `serializeJson`
///         does not guarantee key order or layout.
/// @dev Members are `"key": value` strings; `obj` and `arr` join them. String values are escaped (`"` and `\`);
///      control characters are rejected because no PayLink document needs them. UTF-8 passes through unchanged.
library Json {
    /// @notice `"key": "value"`.
    function str(string memory key, string memory value) internal pure returns (string memory) {
        return string.concat("\"", escape(key), "\": \"", escape(value), "\"");
    }

    /// @notice `"key": <raw JSON>` (number, boolean, null, object or array already serialized).
    function raw(string memory key, string memory json) internal pure returns (string memory) {
        return string.concat("\"", escape(key), "\": ", json);
    }

    /// @notice `"key": 123` (a JSON number; callers keep it below 2^53, or use `str` with a decimal string).
    function num(string memory key, uint256 value) internal pure returns (string memory) {
        return raw(key, Strings.toString(value));
    }

    /// @notice `"key": true|false`.
    function boolean(string memory key, bool value) internal pure returns (string memory) {
        return raw(key, value ? "true" : "false");
    }

    /// @notice Multi-line object; `indent` is the nesting level of its closing brace (two spaces per level).
    function obj(string[] memory members, uint256 indent) internal pure returns (string memory) {
        if (members.length == 0) return "{}";
        return string.concat("{\n", _join(members, indent + 1), "\n", _pad(indent), "}");
    }

    /// @notice Multi-line array of already-serialized items.
    function arr(string[] memory items, uint256 indent) internal pure returns (string memory) {
        if (items.length == 0) return "[]";
        return string.concat("[\n", _join(items, indent + 1), "\n", _pad(indent), "]");
    }

    /// @notice Single-line object.
    function oneLine(string[] memory members) internal pure returns (string memory s) {
        s = "{";
        for (uint256 i = 0; i < members.length; ++i) {
            s = string.concat(s, i == 0 ? "" : ", ", members[i]);
        }
        s = string.concat(s, "}");
    }

    /// @notice Escapes `"` and `\`; reverts on control characters (below 0x20).
    function escape(string memory value) internal pure returns (string memory) {
        bytes memory b = bytes(value);
        bytes memory out = new bytes(b.length * 2);
        uint256 n;
        for (uint256 i = 0; i < b.length; ++i) {
            bytes1 c = b[i];
            require(uint8(c) >= 0x20, "Json: control character");
            if (c == "\"" || c == "\\") out[n++] = "\\";
            out[n++] = c;
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
        return string(out);
    }

    function _join(string[] memory parts, uint256 indent) private pure returns (string memory s) {
        string memory pad = _pad(indent);
        for (uint256 i = 0; i < parts.length; ++i) {
            s = string.concat(s, i == 0 ? "" : ",\n", pad, parts[i]);
        }
    }

    function _pad(uint256 indent) private pure returns (string memory s) {
        for (uint256 i = 0; i < indent; ++i) {
            s = string.concat(s, "  ");
        }
    }
}
