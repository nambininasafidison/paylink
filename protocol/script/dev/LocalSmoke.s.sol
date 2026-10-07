// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {Mock3009} from "../../test/mocks/Mock3009.sol";
import {MockPermit} from "../../test/mocks/MockPermit.sol";

/// @title LocalSmoke: every PayLinkV2 entry point as real transactions on a local anvil node
/// @notice Deploys PayLinkV2 (or uses `PAYLINK_ADDRESS`) and the two mock tokens, then sends one real transaction per
///         entry point and storage situation: payWithAuthorization (relayed), pay, payWithPermit, payNative, cancel and
///         cancelBySig (relayed). Each step's receipt `gasUsed` is the transaction gas a wallet or the relayer pays
///         (intrinsic + calldata + execution - refunds), which `protocol/audit/gas.md` lists next to the forge
///         snapshot. It is also the fixture the e2e harness can start from (spec §4.2).
/// @dev Local only: it refuses any chain id but anvil's default 31337, and signs with anvil's public test mnemonic
///      (accounts 0-3: deployer, payee, payer, relayer). Never point it at a real network.
///      anvil &
///      forge script script/dev/LocalSmoke.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract LocalSmoke is Script {
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 key,uint256 deadline)");

    error NotLocal(uint256 chainId);

    PayLinkV2 internal payLink;
    Mock3009 internal usdc;
    MockPermit internal musd;

    uint256 internal deployerKey;
    uint256 internal payeeKey;
    uint256 internal payerKey;
    uint256 internal relayerKey;
    address internal payee;
    address internal payer;

    uint256 internal _salt;

    function run() external {
        if (block.chainid != 31_337) revert NotLocal(block.chainid);
        deployerKey = vm.deriveKey(MNEMONIC, 0);
        payeeKey = vm.deriveKey(MNEMONIC, 1);
        payerKey = vm.deriveKey(MNEMONIC, 2);
        relayerKey = vm.deriveKey(MNEMONIC, 3);
        payee = vm.addr(payeeKey);
        payer = vm.addr(payerKey);

        address existing = vm.envOr("PAYLINK_ADDRESS", address(0));
        vm.startBroadcast(deployerKey);
        payLink = existing == address(0) ? new PayLinkV2() : PayLinkV2(payable(existing));
        usdc = new Mock3009("Mock USD Coin", "mUSDC", "2", 6);
        musd = new MockPermit("Mock Mezo USD", "mMUSD");
        usdc.mint(payer, 1000e6);
        musd.mint(payer, 1000e18);
        vm.stopBroadcast();
        console.log("PayLinkV2", address(payLink));
        console.log("Mock3009 ", address(usdc));
        console.log("MockPermit", address(musd));

        _authorizationSteps();
        _allowanceSteps();
        _nativeSteps();
        _cancelSteps();
    }

    // ------------------------------------------------------------------ steps

    function _authorizationSteps() internal {
        (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) = _signed(address(usdc), 0, 0);
        // Arguments are built before `vm.broadcast`: the next call after it must be the transaction itself.
        IPayLinkV2.Authorization memory first = _authorize(key, 25e6, "s1");
        IPayLinkV2.Authorization memory repeat = _authorize(key, 25e6, "s2");
        _step("payWithAuthorization_first");
        vm.broadcast(relayerKey);
        payLink.payWithAuthorization(inv, sig, first);
        _step("payWithAuthorization_repeat");
        vm.broadcast(relayerKey);
        payLink.payWithAuthorization(inv, sig, repeat);
    }

    function _allowanceSteps() internal {
        (IPayLinkV2.Invoice memory fixedInv, bytes memory fixedSig,) = _signed(address(musd), 25e18, 1);
        _step("setup: approve");
        vm.broadcast(payerKey);
        musd.approve(address(payLink), 25e18);
        _step("pay_first");
        vm.broadcast(payerKey);
        payLink.pay(fixedInv, fixedSig, 25e18, "INV-0002");

        (IPayLinkV2.Invoice memory openInv, bytes memory openSig,) = _signed(address(musd), 0, 0);
        _step("payWithPermit_first");
        IPayLinkV2.Permit memory p = _permit(25e18);
        vm.broadcast(payerKey);
        payLink.payWithPermit(openInv, openSig, 25e18, "INV-0003", p);
        _step("setup: approve");
        vm.broadcast(payerKey);
        musd.approve(address(payLink), 25e18);
        _step("pay_repeat");
        vm.broadcast(payerKey);
        payLink.pay(openInv, openSig, 25e18, "INV-0003");
    }

    function _nativeSteps() internal {
        (IPayLinkV2.Invoice memory inv, bytes memory sig,) = _signed(address(0), 0, 0);
        _step("payNative_first");
        vm.broadcast(payerKey);
        payLink.payNative{value: 0.01 ether}(inv, sig, "INV-0004");
        _step("payNative_repeat");
        vm.broadcast(payerKey);
        payLink.payNative{value: 0.01 ether}(inv, sig, "INV-0004");
    }

    function _cancelSteps() internal {
        (IPayLinkV2.Invoice memory a,,) = _signed(address(usdc), 25e6, 1);
        _step("cancel");
        vm.broadcast(payeeKey);
        payLink.cancel(a);

        (IPayLinkV2.Invoice memory b,, bytes32 keyB) = _signed(address(usdc), 25e6, 1);
        uint256 deadline = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            payeeKey,
            keccak256(
                abi.encodePacked("\x19\x01", _domainSeparator(), keccak256(abi.encode(CANCEL_TYPEHASH, keyB, deadline)))
            )
        );
        _step("cancelBySig");
        vm.broadcast(relayerKey);
        payLink.cancelBySig(b, deadline, abi.encodePacked(r, s, v));

        IPayLinkV2.LinkState memory st = payLink.stateOf(keyB);
        require(st.cancelled, "LocalSmoke: cancelBySig did not cancel");
    }

    // ------------------------------------------------------------------ helpers

    function _step(string memory name) internal pure {
        console.log("step", name);
    }

    function _signed(address token, uint128 amount, uint32 maxPayments)
        internal
        returns (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key)
    {
        inv = IPayLinkV2.Invoice({
            payee: payee,
            token: token,
            amount: amount,
            validAfter: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 7 days),
            maxPayments: maxPayments,
            salt: keccak256(abi.encode("LocalSmoke", ++_salt, block.timestamp)),
            memoHash: keccak256("Local smoke test")
        });
        key = payLink.invoiceKey(inv);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payeeKey, key);
        sig = abi.encodePacked(r, s, v);
    }

    function _authorize(bytes32 key, uint128 amount, bytes32 payerSalt)
        internal
        view
        returns (IPayLinkV2.Authorization memory auth)
    {
        auth.payer = payer;
        auth.amount = amount;
        auth.payerRef = "INV-0001";
        auth.payerSalt = payerSalt;
        auth.validAfter = 0;
        auth.validBefore = block.timestamp + 1 hours;
        bytes32 nonce = payLink.paymentNonce(key, payer, amount, auth.payerRef, payerSalt);
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                payer,
                address(payLink),
                uint256(amount),
                auth.validAfter,
                auth.validBefore,
                nonce
            )
        );
        (auth.v, auth.r, auth.s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function _permit(uint256 value) internal view returns (IPayLinkV2.Permit memory p) {
        p.deadline = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, payer, address(payLink), value, musd.nonces(payer), p.deadline));
        (p.v, p.r, p.s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", musd.DOMAIN_SEPARATOR(), structHash)));
    }

    function _domainSeparator() internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            payLink.eip712Domain();
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }
}
