// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {Predict} from "../../script/Predict.s.sol";
import {PayLinkRelease} from "../../script/utils/PayLinkRelease.sol";
import {PayLinkV2} from "../../src/PayLinkV2.sol";

/// @dev Exposes the internal helpers of the deployment scripts.
contract DeployHarness is Deploy {
    function build() external view returns (Build memory) {
        return _build();
    }

    function fromBroadcast(string memory json) external view returns (Deployment memory) {
        return _fromBroadcast(json, _build());
    }

    function deploymentJson(Deployment memory d) external view returns (string memory) {
        return _deploymentJson(d, _build());
    }

    function releaseJson() external view returns (string memory) {
        return _releaseJson(_build());
    }

    function verify(address target) external view {
        _verifyDeployed(target, _build());
    }

    function masked(bytes memory code) external view returns (bytes32) {
        return _maskedRuntimeHash(code, _build().immutables);
    }
}

/// @dev Deploy with `PAYLINK_REDEPLOY=true`, without touching the process environment shared by parallel tests.
contract RedeployingDeploy is Deploy {
    function _redeployRequested() internal pure override returns (bool) {
        return true;
    }
}

/// @title Deployment scripts (spec §3.3.7)
/// @notice Release pins and lock file, CREATE2 through the deterministic-deployment proxy at the predicted address,
///         CREATE fallback, idempotent re-runs, chain-independent initCodeHash and masked runtime hash, detection of
///         foreign or copied code, and the broadcast parser behind `deployments/<chainId>.json`. The same flow was run
///         end to end against anvil (factory present on 84532, absent on 10143); see protocol/audit/deployment.md.
/// @dev Skipped under `forge coverage`, which compiles without the optimizer: the scripts refuse that build by
///      design (`NotReleaseBuild`).
contract ScriptsTest is Test {
    DeployHarness internal harness;

    bytes32 internal constant TX_HASH = keccak256("deploy tx");
    /// @dev Chain ids (this one and the next two) that no other test or real network uses, for the tests that write a
    ///      temporary deployment record: one per test, so parallel tests never share a file.
    uint256 internal constant RECORD_TEST_CHAIN = 4_242_424_242;

    modifier releaseBuildOnly() {
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) vm.skip(true);
        _;
    }

    function setUp() public {
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) return;
        harness = new DeployHarness();
    }

    // ================================================================== release identity

    function test_BuildIsTheReleaseBuild() public releaseBuildOnly {
        assertEq(_b().initCode, type(PayLinkV2).creationCode, "initCode");
        assertEq(_b().initCodeHash, keccak256(type(PayLinkV2).creationCode), "initCodeHash");
        assertEq(_b().immutables.length, 7, "OZ EIP712 writes 7 immutables (spec 3.3.7)");
        assertEq(_b().openZeppelin, "5.3.0", "OpenZeppelin");
        assertEq(_b().settingsHash, keccak256(bytes(_b().settings)), "settingsHash");
        assertEq(
            _b().settings,
            "solc=0.8.30+commit.73712a01;evmVersion=paris;optimizer=true;runs=10000;viaIR=false;bytecodeHash=ipfs;cborMetadata=true"
        );
        assertEq(_b().cborMetadata.length, 53, "CBOR: ipfs multihash + solc version + 2-byte length");
        assertLe(_b().runtimeCode.length, 24_576, "EIP-170");
        assertEq(
            _b().create2Address,
            vm.computeCreate2Address(
                keccak256("paylink.v2.0.0"), _b().initCodeHash, 0x4e59b44847b379578588920cA78FbF26c0B4956C
            ),
            "CREATE2 address"
        );
    }

    /// @notice deployments/release.json pins the release identity; any change to the bytecode, compiler settings or
    ///         dependencies shows up as a diff of that file in review.
    function test_ReleaseLockMatchesBuild() public releaseBuildOnly {
        assertEq(
            vm.readFile("deployments/release.json"),
            harness.releaseJson(),
            "deployments/release.json is stale: forge script script/Predict.s.sol --sig 'writeRelease()'"
        );
    }

    function test_Create2AddressAndInitCodeHashAreChainIndependent() public releaseBuildOnly {
        PayLinkRelease.Build memory base = _b(); // chain 31337
        uint256[4] memory chains = [uint256(10_143), 84_532, 421_614, 31_611];
        for (uint256 i = 0; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            PayLinkRelease.Build memory b = harness.build();
            assertEq(b.initCodeHash, base.initCodeHash);
            assertEq(b.create2Address, base.create2Address);
            assertEq(b.maskedRuntimeHash, base.maskedRuntimeHash);
        }
    }

    // ================================================================== Deploy.run()

    function test_RunDeploysThroughTheFactoryAtThePredictedAddress() public releaseBuildOnly {
        Predict predict = new Predict();
        Predict.Prediction memory p = predict.run(DEFAULT_SENDER);
        assertTrue(p.factoryPresent);
        assertEq(p.method, "CREATE2");
        assertEq(p.target, _b().create2Address);
        assertFalse(p.alreadyDeployed);
        assertEq(p.recorded, address(0), "no record for this chain");

        address deployed = new Deploy().run();
        assertEq(deployed, p.target, "landed on the predicted address");
        harness.verify(deployed);
        assertTrue(predict.run(DEFAULT_SENDER).alreadyDeployed);
    }

    function test_RunIsIdempotentAfterCreate2() public releaseBuildOnly {
        Deploy deploy = new Deploy();
        address first = deploy.run();
        uint256 nonce = vm.getNonce(DEFAULT_SENDER);
        address second = deploy.run();
        assertEq(second, first);
        assertEq(vm.getNonce(DEFAULT_SENDER), nonce, "the re-run sent no transaction");
    }

    function test_RunFallsBackToCreateWithoutTheFactory() public releaseBuildOnly {
        vm.etch(0x4e59b44847b379578588920cA78FbF26c0B4956C, "");
        Predict.Prediction memory p = new Predict().run(DEFAULT_SENDER);
        assertFalse(p.factoryPresent);
        assertEq(p.method, "CREATE");
        assertEq(p.target, vm.computeCreateAddress(DEFAULT_SENDER, vm.getNonce(DEFAULT_SENDER)));

        address deployed = new Deploy().run();
        assertEq(deployed, p.target, "CREATE address of the deployer");
        assertTrue(deployed != _b().create2Address);
        harness.verify(deployed);
    }

    /// @notice One deployment per chain: with a `deployments/<chainId>.json` record, a re-run of the CREATE path
    ///         (which would otherwise land a second instance at the deployer's next nonce) only verifies the record.
    function test_RunVerifiesTheRecordedDeploymentInsteadOfRedeploying() public releaseBuildOnly {
        vm.chainId(RECORD_TEST_CHAIN);
        vm.etch(0x4e59b44847b379578588920cA78FbF26c0B4956C, "");
        Deploy deploy = new Deploy();
        address first = deploy.run();
        string memory file = _writeRecord(first);

        Predict.Prediction memory p = new Predict().run(DEFAULT_SENDER);
        uint256 nonce = vm.getNonce(DEFAULT_SENDER);
        address second = deploy.run();
        vm.removeFile(file);
        assertEq(p.recorded, first, "Predict reports the recorded deployment");
        assertEq(second, first, "the recorded deployment");
        assertEq(vm.getNonce(DEFAULT_SENDER), nonce, "no second deployment");
    }

    function test_RunRedeploysWhenExplicitlyAsked() public releaseBuildOnly {
        vm.chainId(RECORD_TEST_CHAIN + 1);
        vm.etch(0x4e59b44847b379578588920cA78FbF26c0B4956C, "");
        Deploy deploy = new RedeployingDeploy();
        address first = deploy.run();
        string memory file = _writeRecord(first);

        address second = deploy.run();
        vm.removeFile(file);
        assertTrue(second != first, "a new instance");
        harness.verify(second);
    }

    function test_RevertWhen_RecordedDeploymentHasNoCode() public releaseBuildOnly {
        vm.chainId(RECORD_TEST_CHAIN + 2);
        address gone = makeAddr("reset chain");
        string memory file = _writeRecord(gone);
        Deploy deploy = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(Deploy.RecordedDeploymentMissing.selector, file, gone));
        deploy.run();
        vm.removeFile(file);
    }

    // ================================================================== code verification

    /// @notice Runtime code differs per chain only inside the immutable ranges; the masked hash is identical.
    function test_MaskedRuntimeHashIsChainIndependent() public releaseBuildOnly {
        uint256 snap = vm.snapshotState();
        vm.chainId(10_143);
        address a = new Deploy().run();
        bytes memory codeA = a.code;
        vm.revertToState(snap);
        vm.chainId(84_532);
        address b = new Deploy().run();
        bytes memory codeB = b.code;

        assertEq(a, b, "same CREATE2 address");
        assertTrue(keccak256(codeA) != keccak256(codeB), "runtime code differs per chain");
        assertEq(codeA.length, codeB.length);
        for (uint256 i = 0; i < codeA.length; ++i) {
            if (codeA[i] != codeB[i]) assertTrue(_inImmutable(i), "difference outside an immutable range");
        }
        assertEq(harness.masked(codeA), _b().maskedRuntimeHash);
        assertEq(harness.masked(codeB), _b().maskedRuntimeHash);
        assertEq(harness.masked(_b().runtimeCode), _b().maskedRuntimeHash, "artifact");
    }

    function test_VerifyRejectsMissingCode() public releaseBuildOnly {
        address nothing = makeAddr("nothing");
        vm.expectRevert(abi.encodeWithSelector(PayLinkRelease.NotDeployed.selector, nothing));
        harness.verify(nothing);
    }

    function test_VerifyRejectsForeignCode() public releaseBuildOnly {
        address impostor = makeAddr("impostor");
        vm.etch(impostor, address(harness).code);
        vm.expectPartialRevert(PayLinkRelease.CodeMismatch.selector);
        harness.verify(impostor);
    }

    /// @notice One byte changed outside the immutable ranges (here, the first opcode) is a different contract.
    function test_VerifyRejectsTamperedCode() public releaseBuildOnly {
        address genuine = new Deploy().run();
        bytes memory code = genuine.code;
        code[0] = code[0] ^ 0x01;
        vm.etch(genuine, code);
        vm.expectPartialRevert(PayLinkRelease.CodeMismatch.selector);
        harness.verify(genuine);
    }

    /// @notice Genuine PayLinkV2 runtime copied to another address keeps the original's immutables: the masked
    ///         hash and even the ERC-5267 domain (which reports `address(this)`) look right, but the cached address
    ///         and domain separator are the original's.
    function test_VerifyRejectsCopiedCode() public releaseBuildOnly {
        address genuine = new Deploy().run();
        address copy = makeAddr("copy");
        vm.etch(copy, genuine.code);
        vm.expectPartialRevert(PayLinkRelease.ImmutablesMismatch.selector);
        harness.verify(copy);
    }

    /// @notice The same code verified under another chain id: the cached chain id and domain separator differ.
    function test_VerifyRejectsDeploymentFromAnotherChain() public releaseBuildOnly {
        address deployed = new Deploy().run();
        vm.chainId(84_532);
        vm.expectPartialRevert(PayLinkRelease.ImmutablesMismatch.selector);
        harness.verify(deployed);
    }

    function test_ImmutablesAreTheConstructorValues() public releaseBuildOnly {
        address deployed = new Deploy().run();
        PayLinkV2 payLink = PayLinkV2(payable(deployed));
        (, string memory name, string memory version,,,,) = payLink.eip712Domain();
        assertEq(name, "PayLink");
        assertEq(version, "2");
        harness.verify(deployed);
    }

    function test_MaskingRejectsMalformedRuntime() public releaseBuildOnly {
        vm.expectRevert(abi.encodeWithSelector(PayLinkRelease.MalformedRuntime.selector, "too short"));
        harness.masked(hex"00");
        vm.expectRevert(abi.encodeWithSelector(PayLinkRelease.MalformedRuntime.selector, "CBOR length"));
        harness.masked(hex"0000ffff");
        vm.expectRevert(abi.encodeWithSelector(PayLinkRelease.MalformedRuntime.selector, "immutable range"));
        harness.masked(hex"00000000");
    }

    // ================================================================== broadcast parser and record

    function test_FromBroadcastCreate2() public releaseBuildOnly {
        address deployed = new Deploy().run();
        PayLinkRelease.Deployment memory d = harness.fromBroadcast(_broadcast("CREATE2", deployed, true));
        assertEq(d.payLink, deployed);
        assertEq(d.method, "CREATE2");
        assertEq(d.deployer, DEFAULT_SENDER);
        assertEq(d.txHash, TX_HASH);
        assertEq(d.blockNumber, 0x2a);
        assertEq(d.chainId, block.chainid);
        assertEq(d.runtimeCodeHash, deployed.codehash);
        assertEq(d.runtimeCodeSize, deployed.code.length);
    }

    function test_FromBroadcastLegacyCall() public releaseBuildOnly {
        address deployed = new Deploy().run();
        PayLinkRelease.Deployment memory d = harness.fromBroadcast(_broadcast("CALL", address(0), true));
        assertEq(d.payLink, deployed);
        assertEq(d.method, "CREATE2");
    }

    function test_FromBroadcastCreate() public releaseBuildOnly {
        vm.etch(0x4e59b44847b379578588920cA78FbF26c0B4956C, "");
        address deployed = new Deploy().run();
        PayLinkRelease.Deployment memory d = harness.fromBroadcast(_broadcast("CREATE", deployed, true));
        assertEq(d.payLink, deployed);
        assertEq(d.method, "CREATE");
    }

    function test_RevertWhen_BroadcastIsForAnotherChain() public releaseBuildOnly {
        string memory json = _broadcast("CREATE2", _b().create2Address, true);
        vm.chainId(84_532);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BroadcastMismatch.selector, "chain"));
        harness.fromBroadcast(json);
    }

    function test_RevertWhen_BroadcastReceiptFailed() public releaseBuildOnly {
        string memory json = _broadcast("CREATE2", _b().create2Address, false);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BroadcastMismatch.selector, "receipt status"));
        harness.fromBroadcast(json);
    }

    function test_RevertWhen_BroadcastCallsAnotherFactory() public releaseBuildOnly {
        string memory json = vm.replace(
            _broadcast("CREATE2", _b().create2Address, true),
            vm.toString(0x4e59b44847b379578588920cA78FbF26c0B4956C),
            vm.toString(makeAddr("other factory"))
        );
        vm.expectRevert(abi.encodeWithSelector(Deploy.BroadcastMismatch.selector, "factory"));
        harness.fromBroadcast(json);
    }

    function test_RevertWhen_BroadcastCreate2AddressDiffers() public releaseBuildOnly {
        vm.expectRevert(abi.encodeWithSelector(Deploy.BroadcastMismatch.selector, "CREATE2 contractAddress"));
        harness.fromBroadcast(_broadcast("CREATE2", makeAddr("elsewhere"), true));
    }

    function test_RevertWhen_BroadcastTypeUnknown() public releaseBuildOnly {
        string memory json = _broadcast("CREATE3", _b().create2Address, true);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BroadcastMismatch.selector, "transactionType"));
        harness.fromBroadcast(json);
    }

    function test_DeploymentJsonIsCompleteAndParses() public releaseBuildOnly {
        vm.chainId(84_532);
        address deployed = new Deploy().run();
        PayLinkRelease.Deployment memory d = harness.fromBroadcast(_broadcast("CREATE2", deployed, true));
        d.gitCommit = "0123456789abcdef0123456789abcdef01234567";
        string memory json = harness.deploymentJson(d);

        assertEq(vm.parseJsonString(json, ".schema"), "paylink.deployment/1");
        assertEq(vm.parseJsonUint(json, ".chainId"), 84_532);
        assertEq(vm.parseJsonString(json, ".caip2"), "eip155:84532");
        assertEq(vm.parseJsonString(json, ".network"), "Base Sepolia");
        assertEq(vm.parseJsonAddress(json, ".address"), deployed);
        assertEq(vm.parseJsonString(json, ".caip10"), string.concat("eip155:84532:", vm.toString(deployed)));
        assertEq(vm.parseJsonString(json, ".deployment.method"), "CREATE2");
        assertEq(vm.parseJsonAddress(json, ".deployment.deployer"), DEFAULT_SENDER);
        assertEq(vm.parseJsonBytes32(json, ".deployment.txHash"), TX_HASH);
        assertEq(vm.parseJsonUint(json, ".deployment.blockNumber"), 0x2a);
        assertEq(vm.parseJsonAddress(json, ".deployment.factory"), 0x4e59b44847b379578588920cA78FbF26c0B4956C);
        assertEq(vm.parseJsonBytes32(json, ".deployment.salt"), keccak256("paylink.v2.0.0"));
        assertEq(vm.parseJsonBytes32(json, ".bytecode.initCodeHash"), _b().initCodeHash);
        assertEq(vm.parseJsonBytes32(json, ".bytecode.maskedRuntimeHash"), _b().maskedRuntimeHash);
        assertEq(vm.parseJsonBytes32(json, ".bytecode.runtimeCodeHash"), deployed.codehash);
        assertEq(vm.parseJsonUint(json, ".bytecode.immutableReferences[0].start"), _b().immutables[0].start);
        assertEq(vm.parseJsonString(json, ".compiler.solc"), "0.8.30+commit.73712a01");
        assertEq(vm.parseJsonString(json, ".compiler.evmVersion"), "paris");
        assertEq(vm.parseJsonBytes32(json, ".compiler.settingsHash"), _b().settingsHash);
        assertEq(vm.parseJsonString(json, ".dependencies['@openzeppelin/contracts']"), "5.3.0");
        assertEq(vm.parseJsonString(json, ".source.commit"), d.gitCommit);
        assertEq(vm.parseJsonAddress(json, ".eip712Domain.verifyingContract"), deployed);
        assertEq(
            vm.parseJsonString(json, ".explorers[0].address"),
            string.concat("https://sepolia.basescan.org/address/", vm.toString(deployed))
        );
        assertEq(
            vm.parseJsonString(json, ".explorers[1].tx"),
            string.concat("https://base-sepolia.blockscout.com/tx/", vm.toString(TX_HASH))
        );
    }

    /// @notice Same key set for both methods (one schema for consumers); the factory fields are `null` for CREATE.
    function test_DeploymentJsonForCreateHasNullFactoryFields() public releaseBuildOnly {
        vm.etch(0x4e59b44847b379578588920cA78FbF26c0B4956C, "");
        address deployed = new Deploy().run();
        string memory json = harness.deploymentJson(harness.fromBroadcast(_broadcast("CREATE", deployed, true)));
        assertEq(vm.parseJsonString(json, ".deployment.method"), "CREATE");
        assertTrue(vm.contains(json, "\"factory\": null,"), "factory is null");
        assertTrue(vm.contains(json, "\"salt\": null,"), "salt is null");
        assertTrue(vm.contains(json, "\"saltPreimage\": null\n"), "saltPreimage is null");
        assertEq(vm.parseJsonString(json, ".network"), "Local (anvil)");
        assertFalse(vm.keyExistsJson(json, ".explorers[0]"), "no explorer for a local chain");
    }

    // ================================================================== helpers

    /// @dev Writes a `deployments/<chainId>.json` record for `payLink` on the current chain id.
    function _writeRecord(address payLink) internal returns (string memory file) {
        PayLinkRelease.Deployment memory d;
        d.chainId = block.chainid;
        d.payLink = payLink;
        d.method = "CREATE";
        d.deployer = DEFAULT_SENDER;
        d.txHash = TX_HASH;
        d.blockNumber = 1;
        d.gitCommit = "test";
        file = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(file, harness.deploymentJson(d));
    }

    /// @dev The release build (memory: legacy codegen cannot copy its nested arrays to storage).
    function _b() internal view returns (PayLinkRelease.Build memory) {
        return harness.build();
    }

    function _inImmutable(uint256 offset) internal view returns (bool) {
        PayLinkRelease.Range[] memory ranges = _b().immutables;
        for (uint256 i = 0; i < ranges.length; ++i) {
            if (offset >= ranges[i].start && offset < ranges[i].start + ranges[i].length) {
                return true;
            }
        }
        return false;
    }

    /// @dev Minimal Foundry 1.8 broadcast file (the fields `record()` reads), in the layout `forge script
    ///      --broadcast` writes to broadcast/Deploy.s.sol/<chainId>/run-latest.json.
    function _broadcast(string memory txType, address contractAddress, bool success)
        internal
        view
        returns (string memory)
    {
        bool isCreate = keccak256(bytes(txType)) == keccak256("CREATE");
        string memory to =
            isCreate ? "null" : string.concat("\"", vm.toString(0x4e59b44847b379578588920cA78FbF26c0B4956C), "\"");
        string memory created =
            contractAddress == address(0) ? "null" : string.concat("\"", vm.toString(contractAddress), "\"");
        return string.concat(
            "{\"transactions\":[{\"hash\":\"",
            vm.toString(TX_HASH),
            "\",\"transactionType\":\"",
            txType,
            "\",\"contractName\":\"PayLinkV2\",\"contractAddress\":",
            created,
            ",\"transaction\":{\"from\":\"",
            vm.toString(DEFAULT_SENDER),
            "\",\"to\":",
            to,
            ",\"nonce\":\"0x0\"}}],\"receipts\":[{\"status\":\"",
            success ? "0x1" : "0x0",
            "\",\"blockNumber\":\"0x2a\",\"transactionHash\":\"",
            vm.toString(TX_HASH),
            "\",\"contractAddress\":",
            isCreate ? created : "null",
            "}],\"chain\":",
            vm.toString(block.chainid),
            "}"
        );
    }
}
