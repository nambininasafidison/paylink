// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {Json} from "./Json.sol";

/// @title PayLinkRelease: identity of the PayLinkV2 release artifact and of its deployments
/// @notice Shared by `Predict.s.sol`, `Deploy.s.sol` and their tests (spec §3.3.7):
///         - the release pins (solc, EVM version, optimizer, bytecode hash, OpenZeppelin version), checked against
///           the compiled artifact so a build with other settings is refused;
///         - `initCodeHash`, identical on every chain because the constructor takes no argument;
///         - the masked runtime hash, identical on every chain: the runtime code with every `immutableReferences`
///           range zeroed (OpenZeppelin `EIP712` stores the chain id, the contract address and derived values as
///           immutables) and the trailing CBOR metadata removed;
///         - the CREATE2 plan: the deterministic-deployment proxy `CREATE2_FACTORY` (forge-std constant,
///           0x4e59b44847b379578588920cA78FbF26c0B4956C) with salt keccak256("paylink.v2.0.0");
///         - the deterministic JSON of `deployments/release.json` and `deployments/<chainId>.json`.
/// @dev Reads `out/PayLinkV2.sol/PayLinkV2.json` and the OpenZeppelin package.json (fs_permissions in
///      foundry.toml). The format is documented in `deployments/README.md`.
abstract contract PayLinkRelease is Script {
    string internal constant CONTRACT_NAME = "PayLinkV2";
    string internal constant RELEASE = "2.0.0";
    string internal constant SALT_PREIMAGE = "paylink.v2.0.0";
    bytes32 internal constant SALT = keccak256("paylink.v2.0.0");

    string internal constant ARTIFACT = "out/PayLinkV2.sol/PayLinkV2.json";
    string internal constant OZ_PACKAGE_JSON = "node_modules/@openzeppelin/contracts/package.json";
    string internal constant DEPLOYMENTS_DIR = "deployments/";
    string internal constant RELEASE_FILE = "deployments/release.json";
    string internal constant REPOSITORY = "https://github.com/nambininasafidison/paylink";
    string internal constant SOURCE_PATH = "protocol/src/PayLinkV2.sol";

    // Release pins (spec §3.3.5). Changing any of them makes a different release with another initCodeHash.
    string internal constant PIN_SOLC = "0.8.30+commit.73712a01";
    string internal constant PIN_EVM_VERSION = "paris";
    uint256 internal constant PIN_OPTIMIZER_RUNS = 10_000;
    string internal constant PIN_BYTECODE_HASH = "ipfs";
    string internal constant PIN_OPENZEPPELIN = "5.3.0";
    string internal constant PIN_FORGE_STD = "v1.17.0";

    /// @dev A byte range of the runtime code. Members in alphabetical order: `vm.parseJson` encodes JSON objects
    ///      with their keys sorted, and `abi.decode` maps them by position.
    struct Range {
        uint256 length;
        uint256 start;
    }

    /// @notice Identity of the compiled release artifact.
    struct Build {
        bytes initCode;
        bytes32 initCodeHash;
        bytes runtimeCode; // artifact runtime: immutables are zero placeholders
        bytes32 maskedRuntimeHash;
        Range[] immutables; // sorted by start
        bytes cborMetadata;
        string settings; // canonical settings string, see `_settingsString`
        bytes32 settingsHash;
        string openZeppelin;
        address create2Address;
    }

    /// @notice One deployment, as recorded in `deployments/<chainId>.json`.
    struct Deployment {
        uint256 chainId;
        address payLink;
        string method; // "CREATE2" or "CREATE"
        address deployer;
        bytes32 txHash;
        uint256 blockNumber;
        bytes32 runtimeCodeHash; // keccak256 of the on-chain runtime code (differs per chain)
        uint256 runtimeCodeSize;
        string gitCommit;
    }

    error NotReleaseBuild(string field, string expected, string actual);
    error ArtifactMismatch(bytes32 artifactInitCodeHash, bytes32 compiledInitCodeHash);
    error MalformedRuntime(string reason);
    error NotDeployed(address target);
    error CodeMismatch(address target, bytes32 expectedMaskedHash, bytes32 actualMaskedHash);
    error DomainMismatch(address target, string field);
    error ImmutablesMismatch(address target, uint256 offset, bytes32 value);

    // ================================================================== build identity

    /// @notice Reads the compiled artifact, refuses it unless it is the release build, and derives its identity.
    function _build() internal view returns (Build memory b) {
        string memory artifact = vm.readFile(ARTIFACT);
        _checkPins(artifact);

        b.initCode = type(PayLinkV2).creationCode;
        b.initCodeHash = keccak256(b.initCode);
        bytes32 artifactInitHash = keccak256(vm.parseJsonBytes(artifact, ".bytecode.object"));
        if (artifactInitHash != b.initCodeHash) revert ArtifactMismatch(artifactInitHash, b.initCodeHash);

        b.runtimeCode = vm.parseJsonBytes(artifact, ".deployedBytecode.object");
        b.immutables = _immutableRanges(artifact);
        b.maskedRuntimeHash = _maskedRuntimeHash(b.runtimeCode, b.immutables);
        b.cborMetadata = _cborMetadata(b.runtimeCode);
        b.settings = _settingsString();
        b.settingsHash = keccak256(bytes(b.settings));
        b.openZeppelin = vm.parseJsonString(vm.readFile(OZ_PACKAGE_JSON), ".version");
        if (keccak256(bytes(b.openZeppelin)) != keccak256(bytes(PIN_OPENZEPPELIN))) {
            revert NotReleaseBuild("@openzeppelin/contracts", PIN_OPENZEPPELIN, b.openZeppelin);
        }
        b.create2Address = vm.computeCreate2Address(SALT, b.initCodeHash, CREATE2_FACTORY);
    }

    /// @dev The compiler settings recorded in the artifact metadata must be the release pins.
    function _checkPins(string memory artifact) internal view {
        _expect("solc", PIN_SOLC, vm.parseJsonString(artifact, ".metadata.compiler.version"));
        _expect("evmVersion", PIN_EVM_VERSION, vm.parseJsonString(artifact, ".metadata.settings.evmVersion"));
        _expect(
            "optimizer.enabled", "true", vm.toString(vm.parseJsonBool(artifact, ".metadata.settings.optimizer.enabled"))
        );
        _expect(
            "optimizer.runs",
            vm.toString(PIN_OPTIMIZER_RUNS),
            vm.toString(vm.parseJsonUint(artifact, ".metadata.settings.optimizer.runs"))
        );
        if (vm.keyExistsJson(artifact, ".metadata.settings.viaIR")) {
            _expect("viaIR", "false", vm.toString(vm.parseJsonBool(artifact, ".metadata.settings.viaIR")));
        }
        _expect(
            "bytecodeHash", PIN_BYTECODE_HASH, vm.parseJsonString(artifact, ".metadata.settings.metadata.bytecodeHash")
        );
    }

    function _expect(string memory field, string memory expected, string memory actual) private pure {
        if (keccak256(bytes(expected)) != keccak256(bytes(actual))) revert NotReleaseBuild(field, expected, actual);
    }

    /// @notice Canonical settings string; `settingsHash` is its keccak256 (UTF-8).
    function _settingsString() internal pure returns (string memory) {
        return string.concat(
            "solc=",
            PIN_SOLC,
            ";evmVersion=",
            PIN_EVM_VERSION,
            ";optimizer=true;runs=",
            vm.toString(PIN_OPTIMIZER_RUNS),
            ";viaIR=false;bytecodeHash=",
            PIN_BYTECODE_HASH,
            ";cborMetadata=true"
        );
    }

    /// @dev `deployedBytecode.immutableReferences` flattened and sorted by start offset.
    function _immutableRanges(string memory artifact) internal pure returns (Range[] memory ranges) {
        string memory base = ".deployedBytecode.immutableReferences";
        string[] memory ids = vm.parseJsonKeys(artifact, base);
        uint256 total;
        Range[][] memory perId = new Range[][](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            perId[i] = abi.decode(vm.parseJson(artifact, string.concat(base, ".", ids[i])), (Range[]));
            total += perId[i].length;
        }
        ranges = new Range[](total);
        uint256 n;
        for (uint256 i = 0; i < perId.length; ++i) {
            for (uint256 j = 0; j < perId[i].length; ++j) {
                ranges[n++] = perId[i][j];
            }
        }
        // Insertion sort: a handful of entries.
        for (uint256 i = 1; i < ranges.length; ++i) {
            Range memory r = ranges[i];
            uint256 j = i;
            while (j > 0 && ranges[j - 1].start > r.start) {
                ranges[j] = ranges[j - 1];
                --j;
            }
            ranges[j] = r;
        }
    }

    /// @notice keccak256 of `code` with every immutable range zeroed and the CBOR metadata (whose length is
    ///         the big-endian uint16 in the last two bytes, plus those two bytes) removed.
    function _maskedRuntimeHash(bytes memory code, Range[] memory ranges) internal pure returns (bytes32) {
        uint256 len = code.length;
        if (len < 2) revert MalformedRuntime("too short");
        uint256 cborLength = uint16(bytes2(bytes.concat(code[len - 2], code[len - 1])));
        if (len < cborLength + 2) revert MalformedRuntime("CBOR length");
        uint256 cut = len - cborLength - 2;
        bytes memory masked = new bytes(cut);
        for (uint256 i = 0; i < cut; ++i) {
            masked[i] = code[i];
        }
        for (uint256 i = 0; i < ranges.length; ++i) {
            if (ranges[i].start + ranges[i].length > cut) revert MalformedRuntime("immutable range");
            for (uint256 j = ranges[i].start; j < ranges[i].start + ranges[i].length; ++j) {
                masked[j] = 0;
            }
        }
        return keccak256(masked);
    }

    function _cborMetadata(bytes memory code) internal pure returns (bytes memory cbor) {
        uint256 len = code.length;
        uint256 cborLength = uint16(bytes2(bytes.concat(code[len - 2], code[len - 1])));
        cbor = new bytes(cborLength + 2);
        for (uint256 i = 0; i < cbor.length; ++i) {
            cbor[i] = code[len - cbor.length + i];
        }
    }

    // ================================================================== on-chain verification

    /// @notice Checks that `target` runs exactly the release, as its constructor would have left it at `target` on
    ///         this chain: masked runtime hash equal to the artifact's, the seven immutable words equal to the values
    ///         the release constructor writes (so together the full runtime code is pinned, and copied code is told
    ///         apart from a deployment), and an ERC-5267 domain {PayLink, 2, this chain, target} with no salt or
    ///         extensions.
    function _verifyDeployed(address target, Build memory b) internal view {
        if (target.code.length == 0) revert NotDeployed(target);
        bytes memory code = target.code;
        bytes32 actual = _maskedRuntimeHash(code, b.immutables);
        if (actual != b.maskedRuntimeHash) revert CodeMismatch(target, b.maskedRuntimeHash, actual);
        _checkImmutables(target, code, b.immutables);
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = PayLinkV2(payable(target)).eip712Domain();
        if (fields != hex"0f") revert DomainMismatch(target, "fields");
        if (keccak256(bytes(name)) != keccak256("PayLink")) revert DomainMismatch(target, "name");
        if (keccak256(bytes(version)) != keccak256("2")) revert DomainMismatch(target, "version");
        if (chainId != block.chainid) revert DomainMismatch(target, "chainId");
        if (verifyingContract != target) revert DomainMismatch(target, "verifyingContract");
        if (salt != bytes32(0) || extensions.length != 0) revert DomainMismatch(target, "salt/extensions");
    }

    /// @notice The values OpenZeppelin `EIP712("PayLink", "2")` stores as immutables when deployed at `target` on
    ///         this chain: hashed name and version, cached domain separator, chain id and address, and the two
    ///         ShortStrings (bytes left-aligned, length in the last byte).
    function _expectedImmutables(address target) internal view returns (bytes32[] memory v) {
        v = new bytes32[](7);
        v[0] = keccak256("PayLink");
        v[1] = keccak256("2");
        v[2] = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                v[0],
                v[1],
                block.chainid,
                target
            )
        );
        v[3] = bytes32(block.chainid);
        v[4] = bytes32(uint256(uint160(target)));
        v[5] = _shortString("PayLink");
        v[6] = _shortString("2");
    }

    /// @dev Each immutable word of `code` must match a distinct expected value (the AST ids that would name them
    ///      are compiler-internal, so the comparison is a multiset match).
    function _checkImmutables(address target, bytes memory code, Range[] memory ranges) internal view {
        bytes32[] memory expected = _expectedImmutables(target);
        if (ranges.length != expected.length) revert ImmutablesMismatch(target, 0, bytes32(ranges.length));
        bool[] memory used = new bool[](expected.length);
        for (uint256 i = 0; i < ranges.length; ++i) {
            uint256 start = ranges[i].start;
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(add(code, 0x20), start))
            }
            bool matched;
            for (uint256 j = 0; j < expected.length && !matched; ++j) {
                if (!used[j] && expected[j] == word) {
                    used[j] = true;
                    matched = true;
                }
            }
            if (!matched) revert ImmutablesMismatch(target, start, word);
        }
    }

    function _shortString(string memory s) private pure returns (bytes32) {
        bytes memory b = bytes(s);
        return bytes32(uint256(bytes32(b)) | b.length);
    }

    // ================================================================== networks (spec §3.4)

    /// @notice Display name and explorer base URLs of the chains in the spec's table; unknown chains get none.
    function _network(uint256 chainId)
        internal
        pure
        returns (string memory name, string[] memory explorerNames, string[] memory explorerUrls)
    {
        explorerNames = new string[](0);
        explorerUrls = new string[](0);
        if (chainId == 10_143) {
            name = "Monad testnet";
            explorerNames = _pair("MonadVision", "Monadscan");
            explorerUrls = _pair("https://testnet.monadvision.com", "https://testnet.monadscan.com");
        } else if (chainId == 143) {
            name = "Monad mainnet";
        } else if (chainId == 84_532) {
            name = "Base Sepolia";
            explorerNames = _pair("Basescan", "Blockscout");
            explorerUrls = _pair("https://sepolia.basescan.org", "https://base-sepolia.blockscout.com");
        } else if (chainId == 421_614) {
            name = "Arbitrum Sepolia";
            explorerNames = _pair("Arbiscan", "Blockscout");
            explorerUrls = _pair("https://sepolia.arbiscan.io", "https://arbitrum-sepolia.blockscout.com");
        } else if (chainId == 31_611) {
            name = "Mezo testnet";
            explorerNames = _one("Mezo Explorer");
            explorerUrls = _one("https://explorer.test.mezo.org");
        } else if (chainId == 31_612) {
            name = "Mezo mainnet";
        } else if (chainId == 5042) {
            name = "Arc mainnet";
        } else if (chainId == 5_042_002) {
            name = "Arc testnet";
            explorerNames = _one("Arc Explorer");
            explorerUrls = _one("https://explorer.testnet.arc.io");
        } else if (chainId == 31_337) {
            name = "Local (anvil)";
        } else {
            name = "Unknown";
        }
    }

    function _pair(string memory a, string memory b) private pure returns (string[] memory list) {
        list = new string[](2);
        list[0] = a;
        list[1] = b;
    }

    function _one(string memory a) private pure returns (string[] memory list) {
        list = new string[](1);
        list[0] = a;
    }

    // ================================================================== JSON documents

    /// @notice `deployments/release.json`: the chain-independent identity of the release artifact.
    function _releaseJson(Build memory b) internal pure returns (string memory) {
        string[] memory top = new string[](8);
        top[0] = Json.str("schema", "paylink.release/1");
        top[1] = Json.str("contract", CONTRACT_NAME);
        top[2] = Json.str("release", RELEASE);
        top[3] = Json.raw("bytecode", _bytecodeJson(b, 1));
        top[4] = Json.raw("compiler", _compilerJson(b, 1));
        top[5] = Json.raw("dependencies", _dependenciesJson(b, 1));
        top[6] = Json.raw("create2", _create2Json(b, 1));
        string[] memory source = new string[](2);
        source[0] = Json.str("repository", REPOSITORY);
        source[1] = Json.str("path", SOURCE_PATH);
        top[7] = Json.raw("source", Json.obj(source, 1));
        return string.concat(Json.obj(top, 0), "\n");
    }

    /// @notice `deployments/<chainId>.json`: one deployment and the release identity it was checked against.
    function _deploymentJson(Deployment memory d, Build memory b) internal pure returns (string memory) {
        (string memory networkName,,) = _network(d.chainId);
        string memory caip2 = string.concat("eip155:", vm.toString(d.chainId));
        string[] memory top = new string[](15);
        top[0] = Json.str("schema", "paylink.deployment/1");
        top[1] = Json.str("contract", CONTRACT_NAME);
        top[2] = Json.str("release", RELEASE);
        top[3] = Json.num("chainId", d.chainId);
        top[4] = Json.str("caip2", caip2);
        top[5] = Json.str("network", networkName);
        top[6] = Json.str("address", vm.toString(d.payLink));
        top[7] = Json.str("caip10", string.concat(caip2, ":", vm.toString(d.payLink)));
        top[8] = Json.raw("deployment", _deploymentTxJson(d, 1));
        top[9] = Json.raw("bytecode", _deployedBytecodeJson(d, b, 1));
        top[10] = Json.raw("compiler", _compilerJson(b, 1));
        top[11] = Json.raw("dependencies", _dependenciesJson(b, 1));
        top[12] = Json.raw("source", _sourceJson(d, 1));
        top[13] = Json.raw("eip712Domain", _domainJson(d, 1));
        top[14] = Json.raw("explorers", _explorersJson(d, 1));
        return string.concat(Json.obj(top, 0), "\n");
    }

    /// @dev The key set is the same for both methods, so consumers can use one schema: the factory fields are
    ///      JSON `null` for a CREATE deployment.
    function _deploymentTxJson(Deployment memory d, uint256 indent) private pure returns (string memory) {
        bool viaFactory = keccak256(bytes(d.method)) == keccak256("CREATE2");
        string[] memory f = new string[](7);
        f[0] = Json.str("method", d.method);
        f[1] = Json.str("deployer", vm.toString(d.deployer));
        f[2] = Json.str("txHash", vm.toString(d.txHash));
        f[3] = Json.num("blockNumber", d.blockNumber);
        if (viaFactory) {
            f[4] = Json.str("factory", vm.toString(CREATE2_FACTORY));
            f[5] = Json.str("salt", vm.toString(SALT));
            f[6] = Json.str("saltPreimage", SALT_PREIMAGE);
        } else {
            f[4] = Json.raw("factory", "null");
            f[5] = Json.raw("salt", "null");
            f[6] = Json.raw("saltPreimage", "null");
        }
        return Json.obj(f, indent);
    }

    function _bytecodeJson(Build memory b, uint256 indent) private pure returns (string memory) {
        string[] memory f = new string[](7);
        f[0] = Json.str("initCodeHash", vm.toString(b.initCodeHash));
        f[1] = Json.num("initCodeSize", b.initCode.length);
        f[2] = Json.str("maskedRuntimeHash", vm.toString(b.maskedRuntimeHash));
        f[3] = Json.num("runtimeCodeSize", b.runtimeCode.length);
        f[4] = Json.str("masking", _maskingRule());
        f[5] = Json.raw("immutableReferences", _rangesJson(b.immutables, indent + 1));
        f[6] = Json.str("cborMetadata", vm.toString(b.cborMetadata));
        return Json.obj(f, indent);
    }

    function _deployedBytecodeJson(Deployment memory d, Build memory b, uint256 indent)
        private
        pure
        returns (string memory)
    {
        string[] memory f = new string[](6);
        f[0] = Json.str("initCodeHash", vm.toString(b.initCodeHash));
        f[1] = Json.str("maskedRuntimeHash", vm.toString(b.maskedRuntimeHash));
        f[2] = Json.str("runtimeCodeHash", vm.toString(d.runtimeCodeHash));
        f[3] = Json.num("runtimeCodeSize", d.runtimeCodeSize);
        f[4] = Json.str("masking", _maskingRule());
        f[5] = Json.raw("immutableReferences", _rangesJson(b.immutables, indent + 1));
        return Json.obj(f, indent);
    }

    function _maskingRule() private pure returns (string memory) {
        return "keccak256 of the runtime code with every immutableReferences range set to zero and the trailing CBOR metadata removed (its length is the big-endian uint16 in the last two bytes, plus those two bytes)";
    }

    function _rangesJson(Range[] memory ranges, uint256 indent) private pure returns (string memory) {
        string[] memory items = new string[](ranges.length);
        for (uint256 i = 0; i < ranges.length; ++i) {
            string[] memory f = new string[](2);
            f[0] = Json.num("start", ranges[i].start);
            f[1] = Json.num("length", ranges[i].length);
            items[i] = Json.oneLine(f);
        }
        return Json.arr(items, indent);
    }

    function _compilerJson(Build memory b, uint256 indent) private pure returns (string memory) {
        string[] memory f = new string[](8);
        f[0] = Json.str("solc", PIN_SOLC);
        f[1] = Json.str("evmVersion", PIN_EVM_VERSION);
        f[2] = Json.boolean("optimizer", true);
        f[3] = Json.num("optimizerRuns", PIN_OPTIMIZER_RUNS);
        f[4] = Json.boolean("viaIR", false);
        f[5] = Json.str("bytecodeHash", PIN_BYTECODE_HASH);
        f[6] = Json.str("settings", b.settings);
        f[7] = Json.str("settingsHash", vm.toString(b.settingsHash));
        return Json.obj(f, indent);
    }

    function _dependenciesJson(Build memory b, uint256 indent) private pure returns (string memory) {
        string[] memory f = new string[](2);
        f[0] = Json.str("@openzeppelin/contracts", b.openZeppelin);
        f[1] = Json.str("forge-std", PIN_FORGE_STD);
        return Json.obj(f, indent);
    }

    function _create2Json(Build memory b, uint256 indent) private pure returns (string memory) {
        string[] memory f = new string[](5);
        f[0] = Json.str("factory", vm.toString(CREATE2_FACTORY));
        f[1] = Json.str("salt", vm.toString(SALT));
        f[2] = Json.str("saltPreimage", SALT_PREIMAGE);
        f[3] = Json.str("address", vm.toString(b.create2Address));
        f[4] = Json.str(
            "note", "Same address on every chain where the factory is deployed; CREATE fallback addresses differ."
        );
        return Json.obj(f, indent);
    }

    function _sourceJson(Deployment memory d, uint256 indent) private pure returns (string memory) {
        string[] memory f = new string[](3);
        f[0] = Json.str("repository", REPOSITORY);
        f[1] = Json.str("path", SOURCE_PATH);
        f[2] = Json.str("commit", d.gitCommit);
        return Json.obj(f, indent);
    }

    function _domainJson(Deployment memory d, uint256 indent) private pure returns (string memory) {
        string[] memory f = new string[](4);
        f[0] = Json.str("name", "PayLink");
        f[1] = Json.str("version", "2");
        f[2] = Json.num("chainId", d.chainId);
        f[3] = Json.str("verifyingContract", vm.toString(d.payLink));
        return Json.obj(f, indent);
    }

    function _explorersJson(Deployment memory d, uint256 indent) private pure returns (string memory) {
        (, string[] memory names, string[] memory urls) = _network(d.chainId);
        string[] memory items = new string[](names.length);
        for (uint256 i = 0; i < names.length; ++i) {
            string[] memory f = new string[](3);
            f[0] = Json.str("name", names[i]);
            f[1] = Json.str("address", string.concat(urls[i], "/address/", vm.toString(d.payLink)));
            f[2] = Json.str("tx", string.concat(urls[i], "/tx/", vm.toString(d.txHash)));
            items[i] = Json.obj(f, indent + 1);
        }
        return Json.arr(items, indent);
    }
}
