// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/console.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {FlakyPayee1271} from "./mocks/FlakyPayee1271.sol";
import {Mock3009Dispatch} from "./mocks/Mock3009Dispatch.sol";

/// @dev A delegate without ERC-1271 (or one that wraps hashes, like Coinbase's 7702 wallet): raw ECDSA no longer
///      verifies through it.
contract NoSignatureDelegate {}

/// @title AUDIT-02/03 regression: a relayer's simulation does not bind inclusion
/// @notice Findings A-02 (medium) and A-03 (low). THREAT_MODEL T-13 (before the fix) said a malicious ERC-1271
///         payee's "effect is limited to payments to that payee; the relayer simulates with a gas ceiling". PayLinkV2
///         calls the payee's `isValidSignature` on every payment (by design), Circle FiatToken calls the payer's when
///         the payer has code, and an EOA payee can simply `cancel` a receive card: each can make a relay that passed
///         `eth_call` revert on inclusion. On Monad the relayer pays the full gas limit of a reverted transaction
///         (spec §3.3.6, C; registry floor 224,000 gas for `payWithAuthorization`), and the requests stay replayable.
///         Status: by design on-chain; fixed in the relayer. `RelayAdmissionLedger`
///         (packages/sdk/src/relay-admission.ts) bounds relays in flight per key, payee, payer and token, bans for a
///         day the party that a post-simulation revert is attributed to (`attributeRelayRevert`; A-04 replaced the
///         original "ban key, payee and payer" rule, which let a sybil payer get an honest payee banned) and strikes
///         the requester, relays payees with code only when allowlisted and payers with code not at all;
///         `checkRelayPayRequest` verifies the payer with the token's dispatch and reports both codes (invoice spec
///         §8.3, §13.3; THREAT_MODEL T-03, T-13, T-46). The SDK's anvil suite replays the cancel case against the
///         admission ledger and attributes it to the payee. These tests pin the behaviour the relayer must assume.
/// @dev Run: forge test --match-path 'test/audit/A02_RelayerGriefing.t.sol' -vv
contract A02RelayerGriefingTest is BaseTest {
    /// @dev packages/chains/src/generated/gas.ts: EMULATED_GAS_LIMITS.monad.payWithAuthorization / cancelBySig floors.
    uint256 internal constant MONAD_PAY_FLOOR = 224_000;
    uint256 internal constant MONAD_CANCEL_FLOOR = 89_000;
    /// @dev Monad minimum base fee, 100 MON-gwei (spec §3.3.6, C).
    uint256 internal constant MONAD_MIN_BASE_FEE = 100 gwei;
    bytes32 internal constant REF = bytes32("GRIEF");

    address internal attacker;
    uint256 internal attackerKey;

    function setUp() public override {
        super.setUp();
        (attacker, attackerKey) = makeAddrAndKey("attacker");
    }

    // ------------------------------------------------------------------ relayer pipeline model

    /// @dev Spec §13.3: simulate with eth_call (state is discarded), then send with an explicit gas limit.
    function _simulate(bytes memory callData) internal returns (bool ok) {
        uint256 snapshot = vm.snapshotState();
        vm.prank(relayer);
        (ok,) = address(payLink).call(callData);
        vm.revertToState(snapshot);
    }

    function _send(bytes memory callData, uint256 gasLimit) internal returns (bool ok, bytes memory ret) {
        vm.prank(relayer);
        (ok, ret) = address(payLink).call{gas: gasLimit}(callData);
    }

    function _openCardFor(address payeeAddr) internal returns (IPayLinkV2.Invoice memory card) {
        card = _invoiceN(address(usdc), 0, 0); // open amount, unlimited: one signature serves every grief
        card.payee = payeeAddr;
        card.validUntil = 0;
    }

    // ------------------------------------------------------------------ payee side (PayLinkV2's own 1271 call)

    /// @notice Zero on-chain cost to the attacker: valid on even blocks only. Simulated at block N, included at N + 1.
    function test_SimulationDoesNotBind_FlakyPayeeRevertsOnInclusion() public {
        FlakyPayee1271 flaky = new FlakyPayee1271(attacker, FlakyPayee1271.Mode.EvenBlocks);
        IPayLinkV2.Invoice memory card = _openCardFor(address(flaky));
        bytes memory sig = _sign(attackerKey, _key(card));
        (address sybil, uint256 sybilKey) = makeAddrAndKey("sybil");
        usdc.mint(sybil, 1);
        IPayLinkV2.Authorization memory auth = _authorize(sybilKey, address(usdc), _key(card), 1, REF, bytes32("s"));
        bytes memory callData = abi.encodeCall(payLink.payWithAuthorization, (card, sig, auth));

        vm.roll(1000);
        assertTrue(_simulate(callData), "relayer simulation at block N passes");

        vm.roll(1001);
        uint256 gasBefore = gasleft();
        (bool ok, bytes memory ret) = _send(callData, MONAD_PAY_FLOOR);
        uint256 used = gasBefore - gasleft();
        assertFalse(ok, "included at N + 1: reverts");
        assertEq(bytes4(ret), IPayLinkV2.InvalidSignature.selector);
        assertFalse(usdc.authorizationState(sybil, _nonce(_key(card), sybil, 1, REF, bytes32("s"))), "replayable");

        console.log("gas used by the reverted relay (Ethereum pricing):", used);
        console.log("gas charged on Monad (= gas limit):", MONAD_PAY_FLOOR);
        console.log("relayer cost per grief at 100 MON-gwei (wei):", MONAD_PAY_FLOOR * MONAD_MIN_BASE_FEE);
    }

    /// @notice One SSTORE by the payee reverts every relay already simulated and queued, however many there are.
    function test_SimulationDoesNotBind_OneToggleRevertsEveryQueuedRelay() public {
        uint256 n = 25;
        FlakyPayee1271 flaky = new FlakyPayee1271(attacker, FlakyPayee1271.Mode.Toggle);
        IPayLinkV2.Invoice memory card = _openCardFor(address(flaky));
        bytes memory sig = _sign(attackerKey, _key(card));

        bytes[] memory queued = new bytes[](n);
        for (uint256 i = 0; i < n; ++i) {
            // Distinct payers defeat per-payer caps; each needs only the minimum amount for the simulation.
            (address sybil, uint256 sybilKey) = makeAddrAndKey(string.concat("sybil-", vm.toString(i)));
            usdc.mint(sybil, 1);
            IPayLinkV2.Authorization memory auth = _authorize(sybilKey, address(usdc), _key(card), 1, REF, bytes32(i));
            queued[i] = abi.encodeCall(payLink.payWithAuthorization, (card, sig, auth));
            assertTrue(_simulate(queued[i]), "every request passes the relayer's simulation");
        }

        vm.prank(attacker);
        uint256 gasBefore = gasleft();
        flaky.setRefusing(true);
        uint256 toggleGas = gasBefore - gasleft();

        for (uint256 i = 0; i < n; ++i) {
            (bool ok, bytes memory ret) = _send(queued[i], MONAD_PAY_FLOOR);
            assertFalse(ok, "queued relay reverts");
            assertEq(bytes4(ret), IPayLinkV2.InvalidSignature.selector);
        }
        uint256 relayerCharged = n * MONAD_PAY_FLOOR;
        // Linear in the number of queued relays; one toggle transaction costs the attacker a constant.
        uint256 amplification = relayerCharged / (toggleGas + 21_000);
        assertGe(amplification, 50, "25 queued relays: relayer pays > 50x the attacker");

        // The authorizations are unconsumed: flip back and the same requests pass simulation again.
        vm.prank(attacker);
        flaky.setRefusing(false);
        assertTrue(_simulate(queued[0]), "request reusable for the next round");

        console.log("attacker toggle (execution gas, + 21000 intrinsic):", toggleGas);
        console.log("relayer gas charged on Monad for the queued relays:", relayerCharged);
        console.log("relayer MON burned at 100 MON-gwei (wei):", relayerCharged * MONAD_MIN_BASE_FEE);
        console.log("amplification (relayer gas / attacker gas):", amplification);
    }

    /// @notice An EOA payee needs no ERC-1271 code: one `cancel` of a receive card reverts every relay queued for that
    ///         card. Restricting relays to EOA payees is therefore not enough; the relayer bounds in-flight relays per
    ///         key and per payee (`RelayAdmissionLedger`), so this action reverts at most one paid relay.
    function test_SimulationDoesNotBind_OneCancelRevertsEveryRelayQueuedForTheCard() public {
        uint256 n = 10;
        IPayLinkV2.Invoice memory card = _openCardFor(attacker);
        bytes memory sig = _sign(attackerKey, _key(card));
        bytes[] memory queued = new bytes[](n);
        for (uint256 i = 0; i < n; ++i) {
            (address sybil, uint256 sybilKey) = makeAddrAndKey(string.concat("eoa-sybil-", vm.toString(i)));
            usdc.mint(sybil, 1);
            queued[i] = abi.encodeCall(
                payLink.payWithAuthorization,
                (card, sig, _authorize(sybilKey, address(usdc), _key(card), 1, REF, bytes32(i)))
            );
            assertTrue(_simulate(queued[i]));
        }
        vm.prank(attacker);
        payLink.cancel(card);
        for (uint256 i = 0; i < n; ++i) {
            (bool ok, bytes memory ret) = _send(queued[i], MONAD_PAY_FLOOR);
            assertFalse(ok);
            assertEq(bytes4(ret), IPayLinkV2.Cancelled.selector);
        }
    }

    /// @notice The relayed `cancelBySig` endpoint has the same exposure.
    function test_SimulationDoesNotBind_FlakyPayeeCancelBySig() public {
        FlakyPayee1271 flaky = new FlakyPayee1271(attacker, FlakyPayee1271.Mode.Toggle);
        IPayLinkV2.Invoice memory card = _openCardFor(address(flaky));
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory cancelSig =
            _sign(attackerKey, _cancelDigest(_key(card), deadline, vm.getChainId(), address(payLink)));
        bytes memory callData = abi.encodeCall(payLink.cancelBySig, (card, deadline, cancelSig));

        assertTrue(_simulate(callData), "simulation passes");
        vm.prank(attacker);
        flaky.setRefusing(true);
        (bool ok, bytes memory ret) = _send(callData, MONAD_CANCEL_FLOOR);
        assertFalse(ok);
        assertEq(bytes4(ret), IPayLinkV2.InvalidSignature.selector);
    }

    // ------------------------------------------------------------------ payer side (FiatToken's 1271 dispatch)

    /// @notice FiatToken v2.2 verifies a payer that has code through ERC-1271 (the SDK relay check verified with
    ///         local ECDSA only before the fix; it now uses the token's dispatch). A payer that sets an EIP-7702
    ///         delegation between simulation and inclusion still makes the relay revert, and one type-4 transaction can
    ///         carry many authorization tuples: hence the per-payer and per-token in-flight bounds and the bans.
    function test_SimulationDoesNotBind_Delegated7702PayerRevertsOnInclusion() public {
        vm.setEvmVersion("prague");
        Mock3009Dispatch dusd = new Mock3009Dispatch();
        NoSignatureDelegate delegate = new NoSignatureDelegate();

        IPayLinkV2.Invoice memory inv = _invoice(address(dusd), USDC_25);
        bytes memory sig = _signInvoice(inv);
        bytes32 key = _key(inv);
        dusd.mint(payer, USDC_25);

        IPayLinkV2.Authorization memory auth;
        auth.payer = payer;
        auth.amount = USDC_25;
        auth.payerRef = REF;
        auth.payerSalt = bytes32("s");
        auth.validBefore = vm.getBlockTimestamp() + 600;
        bytes32 nonce = _nonce(key, payer, USDC_25, REF, bytes32("s"));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                dusd.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        dusd.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        payer,
                        address(payLink),
                        uint256(USDC_25),
                        uint256(0),
                        auth.validBefore,
                        nonce
                    )
                )
            )
        );
        (auth.v, auth.r, auth.s) = vm.sign(payerKey, digest);
        assertEq(ecrecover(digest, auth.v, auth.r, auth.s), payer, "the SDK's local ECDSA check passes");

        bytes memory callData = abi.encodeCall(payLink.payWithAuthorization, (inv, sig, auth));
        assertTrue(_simulate(callData), "simulation passes while the payer has no code");

        // The payer's EIP-7702 delegation lands first (designator 0xef0100 || delegate).
        vm.etch(payer, abi.encodePacked(hex"ef0100", address(delegate)));
        (bool ok, bytes memory ret) = _send(callData, MONAD_PAY_FLOOR);
        assertFalse(ok, "relay reverts: the token now asks the delegate");
        assertEq(ret, abi.encodeWithSignature("Error(string)", "FiatTokenV2: invalid signature"));

        // Clearing the delegation makes the same request valid again (repeatable).
        vm.etch(payer, "");
        assertTrue(_simulate(callData), "same request passes simulation again");
    }
}
