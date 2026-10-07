// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";

/// @title Release import graph: exactly the audited sources, and never `utils/Bytes.sol`
/// @notice Spec §3.3.5. The only advisory against OpenZeppelin 5.3.0, GHSA-9rcw-c2f9-2j55 (`Bytes.lastIndexOf`
///         out-of-bounds read, `>=5.2.0 <5.4.0`), lives in `utils/Bytes.sol`, which PayLinkV2 must never compile in.
///         The workspace audit keeps a documented exception for that advisory; this test is what makes the exception
///         safe. It reads the source list solc recorded in the PayLinkV2 artifact metadata (the exact set of files the
///         release bytecode was compiled from) and requires it to equal the reviewed import graph below:
///         EIP712 -> MessageHashUtils -> Strings -> Math/SafeCast/SignedMath; ShortStrings -> StorageSlot;
///         SignatureChecker -> ECDSA/IERC1271; SafeERC20 -> IERC20/IERC1363; Address -> Errors.
///         Any new import, direct or transitive, fails here and has to be reviewed (and this list updated).
/// @dev The artifact must be the one this run compiled. `forge test` rebuilds `out/` before running, and importing
///      PayLinkV2 here puts it in every build that includes this suite, so the artifact is fresh. Two runs do not
///      write `out/`, and each would read whatever an earlier build left there:
///      - `forge coverage` compiles an unoptimized, instrumented build elsewhere: the suite skips itself, like
///        `test/script/Scripts.t.sol` and `test/gas/Gas.t.sol`; `forge test` remains the authoritative run;
///      - any other stale artifact (the sources changed since `out/` was written) is refused: the artifact's init
///        code must equal `type(PayLinkV2).creationCode`, the code this very test binary was compiled with.
contract ReleaseGraphTest is Test {
    string internal constant ARTIFACT = "out/PayLinkV2.sol/PayLinkV2.json";
    string internal constant OZ = "node_modules/@openzeppelin/contracts/";

    /// @dev Skips the artifact checks under `forge coverage`, which never writes `out/`.
    modifier releaseBuildOnly() {
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) vm.skip(true);
        _;
    }

    function _expectedSources() internal pure returns (string[26] memory) {
        return [
            string.concat(OZ, "interfaces/IERC1271.sol"),
            string.concat(OZ, "interfaces/IERC1363.sol"),
            string.concat(OZ, "interfaces/IERC165.sol"),
            string.concat(OZ, "interfaces/IERC20.sol"),
            string.concat(OZ, "interfaces/IERC5267.sol"),
            string.concat(OZ, "token/ERC20/IERC20.sol"),
            string.concat(OZ, "token/ERC20/extensions/IERC20Permit.sol"),
            string.concat(OZ, "token/ERC20/utils/SafeERC20.sol"),
            string.concat(OZ, "utils/Address.sol"),
            string.concat(OZ, "utils/Errors.sol"),
            string.concat(OZ, "utils/Panic.sol"),
            string.concat(OZ, "utils/ReentrancyGuard.sol"),
            string.concat(OZ, "utils/ShortStrings.sol"),
            string.concat(OZ, "utils/StorageSlot.sol"),
            string.concat(OZ, "utils/Strings.sol"),
            string.concat(OZ, "utils/cryptography/ECDSA.sol"),
            string.concat(OZ, "utils/cryptography/EIP712.sol"),
            string.concat(OZ, "utils/cryptography/MessageHashUtils.sol"),
            string.concat(OZ, "utils/cryptography/SignatureChecker.sol"),
            string.concat(OZ, "utils/introspection/IERC165.sol"),
            string.concat(OZ, "utils/math/Math.sol"),
            string.concat(OZ, "utils/math/SafeCast.sol"),
            string.concat(OZ, "utils/math/SignedMath.sol"),
            "src/PayLinkV2.sol",
            "src/interfaces/IERC3009.sol",
            "src/interfaces/IPayLinkV2.sol"
        ];
    }

    /// @dev Source list of the release artifact, after checking that the artifact is this build's PayLinkV2.
    function _compiledSources() internal view returns (string[] memory) {
        string memory artifact = vm.readFile(ARTIFACT);
        assertEq(
            keccak256(vm.parseJsonBytes(artifact, ".bytecode.object")),
            keccak256(type(PayLinkV2).creationCode),
            "out/PayLinkV2.sol/PayLinkV2.json is stale or not the release build: run forge build (or forge test)"
        );
        return vm.parseJsonKeys(artifact, ".metadata.sources");
    }

    /// @notice The compiled source set equals the reviewed import graph, file for file.
    function test_ReleaseCompilesExactlyTheReviewedSources() public releaseBuildOnly {
        string[] memory compiled = _compiledSources();
        string[26] memory expected = _expectedSources();
        assertEq(compiled.length, expected.length, "number of compiled sources changed: review the new imports");
        for (uint256 i = 0; i < compiled.length; ++i) {
            bool listed;
            for (uint256 j = 0; j < expected.length && !listed; ++j) {
                listed = keccak256(bytes(compiled[i])) == keccak256(bytes(expected[j]));
            }
            assertTrue(listed, string.concat("unreviewed source in the release build: ", compiled[i]));
        }
    }

    /// @notice GHSA-9rcw-c2f9-2j55: `utils/Bytes.sol` is not part of the release build.
    function test_BytesSolIsNotCompiledIn() public releaseBuildOnly {
        string[] memory compiled = _compiledSources();
        assertGt(compiled.length, 0, "artifact metadata lists no sources");
        for (uint256 i = 0; i < compiled.length; ++i) {
            assertFalse(
                _endsWith(compiled[i], "/utils/Bytes.sol"), string.concat("advisory-affected source: ", compiled[i])
            );
        }
    }

    /// @notice Negative control for the suffix matcher the advisory check relies on.
    function test_SuffixMatcher() public pure {
        assertTrue(_endsWith(string.concat(OZ, "utils/Bytes.sol"), "/utils/Bytes.sol"));
        assertFalse(_endsWith(string.concat(OZ, "utils/Bytes32.sol"), "/utils/Bytes.sol"));
        assertFalse(_endsWith("Bytes.sol", "/utils/Bytes.sol"));
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suffix);
        if (b.length > a.length) return false;
        for (uint256 i = 0; i < b.length; ++i) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }
}
