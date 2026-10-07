// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/console.sol";

import {PayLinkRelease} from "./utils/PayLinkRelease.sol";

/// @title Predict: release identity and deployment addresses, before anything is signed
/// @notice Prints the initCodeHash, the masked runtime hash, the compiler settings hash and the address a
///         deployment would get on the connected chain: the CREATE2 address (same on every chain) when the
///         deterministic-deployment proxy exists there, otherwise the CREATE address of the deployer at its current
///         nonce. Read-only: it never broadcasts. Spec §3.3.7 and §6.4 (the deployer checks these values before
///         signing).
/// @dev Usage (in protocol/):
///      forge script script/Predict.s.sol --rpc-url <rpc> --sig 'run(address)' <deployer>
///      forge script script/Predict.s.sol --sig 'writeRelease()'    # regenerate deployments/release.json
contract Predict is PayLinkRelease {
    /// @notice A deployment plan for one chain and deployer.
    struct Prediction {
        uint256 chainId;
        bytes32 initCodeHash;
        bytes32 maskedRuntimeHash;
        bytes32 settingsHash;
        bool factoryPresent;
        address create2Address;
        address deployer;
        uint64 deployerNonce;
        address createAddress;
        string method; // what Deploy.s.sol will use: "CREATE2" or "CREATE"
        address target;
        bool alreadyDeployed; // code already at `target` (CREATE2 re-run: Deploy.s.sol only verifies it)
        address recorded; // address in deployments/<chainId>.json, or 0: Deploy.s.sol then only verifies it
    }

    /// @notice Prediction for the script's sender (`--sender`, or Foundry's default sender).
    function run() external view returns (Prediction memory) {
        return run(msg.sender);
    }

    /// @notice Prediction for `deployer` on the connected chain.
    function run(address deployer) public view returns (Prediction memory p) {
        Build memory b = _build();
        p.chainId = block.chainid;
        p.initCodeHash = b.initCodeHash;
        p.maskedRuntimeHash = b.maskedRuntimeHash;
        p.settingsHash = b.settingsHash;
        p.factoryPresent = CREATE2_FACTORY.code.length != 0;
        p.create2Address = b.create2Address;
        p.deployer = deployer;
        p.deployerNonce = vm.getNonce(deployer);
        p.createAddress = vm.computeCreateAddress(deployer, p.deployerNonce);
        bool create2 = p.factoryPresent && !vm.envOr("PAYLINK_FORCE_CREATE", false);
        p.method = create2 ? "CREATE2" : "CREATE";
        p.target = create2 ? p.create2Address : p.createAddress;
        p.alreadyDeployed = p.target.code.length != 0;
        string memory recordFile = string.concat(DEPLOYMENTS_DIR, vm.toString(p.chainId), ".json");
        if (vm.exists(recordFile)) p.recorded = vm.parseJsonAddress(vm.readFile(recordFile), ".address");
        _log(p, b);
    }

    /// @notice Regenerates `deployments/release.json` from the current build. The release lock test fails until the
    ///         file matches the build, so any change to the bytecode is visible in review.
    function writeRelease() external {
        Build memory b = _build();
        vm.writeFile(RELEASE_FILE, _releaseJson(b));
        console.log("wrote", RELEASE_FILE);
        console.log("initCodeHash");
        console.logBytes32(b.initCodeHash);
    }

    function _log(Prediction memory p, Build memory b) internal pure {
        (string memory network,,) = _network(p.chainId);
        console.log("PayLinkV2", RELEASE, "on", network);
        console.log("  chainId          ", p.chainId);
        console.log("  initCodeHash     ", vm.toString(p.initCodeHash));
        console.log("  initCodeSize     ", b.initCode.length);
        console.log("  maskedRuntimeHash", vm.toString(p.maskedRuntimeHash));
        console.log("  settings         ", b.settings);
        console.log("  settingsHash     ", vm.toString(p.settingsHash));
        console.log("  CREATE2 factory  ", CREATE2_FACTORY, p.factoryPresent ? "(present)" : "(absent)");
        console.log("  CREATE2 address  ", p.create2Address);
        console.log("  deployer / nonce ", p.deployer, p.deployerNonce);
        console.log("  CREATE address   ", p.createAddress);
        console.log("  method -> target ", p.method, p.target);
        if (p.alreadyDeployed) console.log("  code already present at the target");
        if (p.recorded != address(0)) {
            console.log("  recorded deployment", p.recorded, "(Deploy.s.sol only verifies it; PAYLINK_REDEPLOY=true)");
        }
    }
}
