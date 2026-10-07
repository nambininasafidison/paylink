// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/console.sol";

import {PayLinkV2} from "../src/PayLinkV2.sol";
import {PayLinkRelease} from "./utils/PayLinkRelease.sol";

/// @title Deploy: one PayLinkV2 deployment per chain, then a verified record of it
/// @notice `run()` deploys through the deterministic-deployment proxy (CREATE2, same address on every chain) when
///         `eth_getCode` shows it on the chain, otherwise with a plain CREATE from the deployer (spec §3.3.7). It
///         refuses any build that is not the release build, checks the address it lands on against the prediction,
///         then checks the deployed code (masked runtime hash) and its ERC-5267 domain. A re-run after a CREATE2
///         deployment, or on a chain that already has a `deployments/<chainId>.json` record, only verifies the
///         existing contract. `record()` runs after the broadcast: it reads Foundry's broadcast receipt, re-verifies
///         the code on the live chain and writes `deployments/<chainId>.json`.
/// @dev Usage (in protocol/; the key stays in the wallet or the CI secret, never on the command line in a log):
///      forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --account <keystore> [--sender <addr>]
///      PAYLINK_GIT_COMMIT=$(git rev-parse HEAD) forge script script/Deploy.s.sol --rpc-url <rpc> --sig 'record()'
///      Set PAYLINK_FORCE_CREATE=true to skip the factory, PAYLINK_REDEPLOY=true to deploy although
///      deployments/<chainId>.json exists. The deployer pays gas only; the contract has no owner.
contract Deploy is PayLinkRelease {
    error FactoryCallFailed(bytes returnData);
    error UnexpectedAddress(address expected, address actual);
    error BroadcastMismatch(string field);
    error RecordedDeploymentMissing(string recordFile, address recorded);

    /// @notice Deploys PayLinkV2 on the connected chain, or verifies the existing deployment (CREATE2 address
    ///         already occupied, or a `deployments/<chainId>.json` record).
    /// @return payLink The verified deployment.
    function run() external returns (address payLink) {
        Build memory b = _build();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        string memory method;
        (payLink, method) = _deploy(b, deployer);
        vm.stopBroadcast();
        _verifyDeployed(payLink, b);

        (string memory network,,) = _network(block.chainid);
        console.log("PayLinkV2", RELEASE, "verified on", network);
        console.log("  address          ", payLink);
        console.log("  method           ", method);
        console.log("  deployer         ", deployer);
        console.log("  initCodeHash     ", vm.toString(b.initCodeHash));
        console.log("  maskedRuntimeHash", vm.toString(b.maskedRuntimeHash));
        console.log("Next: forge script script/Deploy.s.sol --rpc-url <rpc> --sig 'record()'");
    }

    /// @dev Runs inside an active broadcast from `deployer`. One deployment per chain: when
    ///      `deployments/<chainId>.json` already records one, it is only verified (a CREATE re-run would otherwise
    ///      deploy a second instance at the deployer's next nonce). `PAYLINK_REDEPLOY=true` overrides, for a chain
    ///      that was reset or a deliberate incident-response redeploy.
    function _deploy(Build memory b, address deployer) internal returns (address payLink, string memory method) {
        string memory recordFile = string.concat(DEPLOYMENTS_DIR, vm.toString(block.chainid), ".json");
        if (vm.exists(recordFile) && !_redeployRequested()) {
            string memory recorded = vm.readFile(recordFile);
            payLink = vm.parseJsonAddress(recorded, ".address");
            if (payLink.code.length == 0) revert RecordedDeploymentMissing(recordFile, payLink);
            console.log(string.concat("Already deployed (", recordFile, "): verifying only."));
            return (payLink, vm.parseJsonString(recorded, ".deployment.method"));
        }
        if (CREATE2_FACTORY.code.length != 0 && !vm.envOr("PAYLINK_FORCE_CREATE", false)) {
            method = "CREATE2";
            payLink = b.create2Address;
            if (payLink.code.length != 0) {
                console.log("Already deployed at the CREATE2 address: verifying only.");
                return (payLink, method);
            }
            // Deterministic-deployment proxy: calldata = salt ++ initCode, returns the 20-byte address.
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call(bytes.concat(SALT, b.initCode));
            if (!ok || ret.length != 20) revert FactoryCallFailed(ret);
            address deployed = address(bytes20(ret));
            if (deployed != payLink) revert UnexpectedAddress(payLink, deployed);
        } else {
            method = "CREATE";
            address expected = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
            payLink = address(new PayLinkV2());
            if (payLink != expected) revert UnexpectedAddress(expected, payLink);
        }
    }

    /// @dev `PAYLINK_REDEPLOY=true`. Virtual so tests can request it without mutating the process environment.
    function _redeployRequested() internal view virtual returns (bool) {
        return vm.envOr("PAYLINK_REDEPLOY", false);
    }

    /// @notice Writes `deployments/<chainId>.json` from Foundry's latest broadcast of this script on this chain.
    function record() external returns (Deployment memory d) {
        d = record(string.concat("broadcast/Deploy.s.sol/", vm.toString(block.chainid), "/run-latest.json"));
    }

    /// @notice Same as `record()` with an explicit broadcast file.
    function record(string memory broadcastFile) public returns (Deployment memory d) {
        Build memory b = _build();
        d = _fromBroadcast(vm.readFile(broadcastFile), b);
        _verifyDeployed(d.payLink, b);
        string memory out = string.concat(DEPLOYMENTS_DIR, vm.toString(block.chainid), ".json");
        vm.writeFile(out, _deploymentJson(d, b));
        console.log("wrote", out);
    }

    /// @notice Reads the deployment transaction from a Foundry broadcast file and the deployed code from the
    ///         connected chain. Pure parsing plus code reads: it writes nothing.
    function _fromBroadcast(string memory broadcast, Build memory b) internal view returns (Deployment memory d) {
        if (vm.parseJsonUint(broadcast, ".chain") != block.chainid) revert BroadcastMismatch("chain");
        if (vm.parseJsonUint(broadcast, ".receipts[0].status") != 1) revert BroadcastMismatch("receipt status");
        bytes32 txHash = vm.parseJsonBytes32(broadcast, ".transactions[0].hash");
        if (vm.parseJsonBytes32(broadcast, ".receipts[0].transactionHash") != txHash) {
            revert BroadcastMismatch("receipt transactionHash");
        }
        string memory txType = vm.parseJsonString(broadcast, ".transactions[0].transactionType");
        d.chainId = block.chainid;
        d.txHash = txHash;
        d.deployer = vm.parseJsonAddress(broadcast, ".transactions[0].transaction.from");
        d.blockNumber = vm.parseJsonUint(broadcast, ".receipts[0].blockNumber");
        bytes32 kind = keccak256(bytes(txType));
        if (kind == keccak256("CREATE2") || kind == keccak256("CALL")) {
            // Foundry 1.8 labels a call to the deterministic-deployment proxy "CREATE2" and fills contractAddress;
            // older versions record a plain "CALL". Either way the address is the CREATE2 prediction.
            if (vm.parseJsonAddress(broadcast, ".transactions[0].transaction.to") != CREATE2_FACTORY) {
                revert BroadcastMismatch("factory");
            }
            d.method = "CREATE2";
            d.payLink = b.create2Address;
            if (
                kind == keccak256("CREATE2")
                    && vm.parseJsonAddress(broadcast, ".transactions[0].contractAddress") != d.payLink
            ) revert BroadcastMismatch("CREATE2 contractAddress");
        } else if (kind == keccak256("CREATE")) {
            d.method = "CREATE";
            d.payLink = vm.parseJsonAddress(broadcast, ".transactions[0].contractAddress");
            if (vm.parseJsonAddress(broadcast, ".receipts[0].contractAddress") != d.payLink) {
                revert BroadcastMismatch("receipt contractAddress");
            }
        } else {
            revert BroadcastMismatch("transactionType");
        }
        d.runtimeCodeHash = d.payLink.codehash;
        d.runtimeCodeSize = d.payLink.code.length;
        d.gitCommit = vm.envOr("PAYLINK_GIT_COMMIT", vm.envOr("GITHUB_SHA", string("unknown")));
    }
}
