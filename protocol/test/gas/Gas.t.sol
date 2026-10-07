// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VmSafe} from "forge-std/Vm.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {Wallet1271} from "../mocks/Wallet1271.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @title Gas benchmarks per entry point (spec §3.3.6)
/// @notice One measurement per entry point and storage situation, written to `snapshots/PayLinkV2.json` by Foundry's
///         gas-snapshot cheatcodes. The file is a regression baseline: CI fails when a change moves a figure, and the
///         diff shows by how much.
/// @dev These are Foundry in-test figures, not transaction gas. Measured against anvil they exceed the real
///      execution gas by about 20k per call (`cancel`: 52,995 here, 32,351 executed on anvil). The likely cause is
///      that Foundry prices storage writes against the state before `setUp` (EIP-2200 "original values") rather than
///      committed state, so the reentrancy guard's first write looks like a fresh one. The excess happens to land the
///      figures within 0.5k of the real *transaction* gas (21,000 intrinsic plus calldata, minus refunds); that is a
///      coincidence of two offsets, not a property to rely on. The gas limits in packages/chains (floor and ceiling
///      per function and chain, spec §3.3.6) therefore come from real receipts: `script/dev/LocalSmoke.s.sol` on
///      anvil, then each testnet with cold slots. `protocol/audit/gas.md` lists both sets of numbers.
///      Every measured call first cools the accounts and slots it touches (`vm.cool`), so "repeat" cases are not
///      flattered by the warm-up payment. "first" = the link's slot goes from zero to non-zero; "repeat" = a later
///      payment of an unlimited link (non-zero to non-zero, payee already funded). The tokens are the test mocks; real
///      FiatToken (USDC) and AUSD proxies cost more per call.
///      Skipped under `forge coverage`, whose unoptimized build would overwrite the baseline with other figures.
contract GasTest is BaseTest {
    string internal constant GROUP = "PayLinkV2";
    bytes32 internal constant REF = bytes32("INV-0001");

    function setUp() public override {
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) vm.skip(true);
        super.setUp();
    }

    function _cool(address token, address payeeAddr, address payerAddr) internal {
        vm.cool(address(payLink));
        vm.cool(payeeAddr);
        vm.cool(payerAddr);
        if (token != address(0)) vm.cool(token);
    }

    function _signed(address token, uint128 amount, uint32 maxPayments)
        internal
        returns (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key)
    {
        inv = _invoiceN(token, amount, maxPayments);
        sig = _signInvoice(inv);
        key = _key(inv);
    }

    // ------------------------------------------------------------------ deployment

    function test_Gas_Deploy() public {
        vm.startSnapshotGas(GROUP, "deploy");
        PayLinkV2 fresh = new PayLinkV2();
        uint256 used = vm.stopSnapshotGas();
        assertGt(address(fresh).code.length, 0);
        assertGt(used, 0);
    }

    // ------------------------------------------------------------------ EIP-3009 (relayer)

    function test_Gas_PayWithAuthorization_First() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) = _signed(address(usdc), USDC_25, 1);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, USDC_25, REF, "s1");
        _cool(address(usdc), payee, payer);
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, auth);
        vm.snapshotGasLastFrame(GROUP, "payWithAuthorization_first");
    }

    function test_Gas_PayWithAuthorization_Repeat() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig, bytes32 key) = _signed(address(usdc), 0, 0);
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, _authorize(payerKey, address(usdc), key, USDC_25, REF, "s1"));
        vm.warp(vm.getBlockTimestamp() + 1);

        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, USDC_25, REF, "s2");
        _cool(address(usdc), payee, payer);
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, auth);
        vm.snapshotGasLastFrame(GROUP, "payWithAuthorization_repeat");
    }

    /// @notice Ceiling input: an ERC-1271 payee adds a cold account access and its own verification cost.
    function test_Gas_PayWithAuthorization_Erc1271Payee() public {
        Wallet1271 wallet = new Wallet1271(payee);
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        inv.payee = address(wallet);
        bytes32 key = _key(inv);
        bytes memory sig = _sign(payeeKey, key);
        IPayLinkV2.Authorization memory auth = _authorize(payerKey, address(usdc), key, USDC_25, REF, "s1");
        _cool(address(usdc), address(wallet), payer);
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, sig, auth);
        vm.snapshotGasLastFrame(GROUP, "payWithAuthorization_erc1271Payee");
    }

    // ------------------------------------------------------------------ allowance

    function test_Gas_Pay_First() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig,) = _signed(address(musd), 25e18, 1);
        vm.prank(payer);
        musd.approve(address(payLink), 25e18);
        _cool(address(musd), payee, payer);
        vm.prank(payer);
        payLink.pay(inv, sig, 25e18, REF);
        vm.snapshotGasLastFrame(GROUP, "pay_first");
    }

    function test_Gas_Pay_Repeat() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig,) = _signed(address(musd), 0, 0);
        vm.startPrank(payer);
        musd.approve(address(payLink), 50e18);
        payLink.pay(inv, sig, 25e18, REF);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1);

        _cool(address(musd), payee, payer);
        vm.prank(payer);
        payLink.pay(inv, sig, 25e18, REF);
        vm.snapshotGasLastFrame(GROUP, "pay_repeat");
    }

    // ------------------------------------------------------------------ permit

    function test_Gas_PayWithPermit_First() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig,) = _signed(address(musd), 25e18, 1);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 25e18, vm.getBlockTimestamp() + 1 hours);
        _cool(address(musd), payee, payer);
        vm.prank(payer);
        payLink.payWithPermit(inv, sig, 25e18, REF, p);
        vm.snapshotGasLastFrame(GROUP, "payWithPermit_first");
    }

    // ------------------------------------------------------------------ native

    function test_Gas_PayNative_First() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig,) = _signed(address(0), 1 ether, 1);
        _cool(address(0), payee, payer);
        vm.prank(payer);
        payLink.payNative{value: 1 ether}(inv, sig, REF);
        vm.snapshotGasLastFrame(GROUP, "payNative_first");
    }

    function test_Gas_PayNative_Repeat() public {
        (IPayLinkV2.Invoice memory inv, bytes memory sig,) = _signed(address(0), 0, 0);
        vm.prank(payer);
        payLink.payNative{value: 1 ether}(inv, sig, REF);
        vm.warp(vm.getBlockTimestamp() + 1);

        _cool(address(0), payee, payer);
        vm.prank(payer);
        payLink.payNative{value: 1 ether}(inv, sig, REF);
        vm.snapshotGasLastFrame(GROUP, "payNative_repeat");
    }

    // ------------------------------------------------------------------ revocation

    function test_Gas_Cancel() public {
        (IPayLinkV2.Invoice memory inv,,) = _signed(address(usdc), USDC_25, 1);
        _cool(address(0), payee, payer);
        vm.prank(payee);
        payLink.cancel(inv);
        vm.snapshotGasLastFrame(GROUP, "cancel");
    }

    function test_Gas_CancelBySig() public {
        (IPayLinkV2.Invoice memory inv,,) = _signed(address(usdc), USDC_25, 1);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);
        _cool(address(0), payee, relayer);
        vm.prank(relayer);
        payLink.cancelBySig(inv, deadline, cancelSig);
        vm.snapshotGasLastFrame(GROUP, "cancelBySig");
    }

    function test_Gas_CancelBySig_Erc1271Payee() public {
        Wallet1271 wallet = new Wallet1271(payee);
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        inv.payee = address(wallet);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory cancelSig = _signCancel(payeeKey, inv, deadline);
        _cool(address(0), address(wallet), relayer);
        vm.prank(relayer);
        payLink.cancelBySig(inv, deadline, cancelSig);
        vm.snapshotGasLastFrame(GROUP, "cancelBySig_erc1271Payee");
    }

    // ------------------------------------------------------------------ batched read

    /// @notice The largest `statesOf` batch, every key cold: the budget an RPC `eth_call` needs.
    function test_Gas_StatesOf_MaxBatch() public {
        bytes32[] memory keys = new bytes32[](256);
        for (uint256 i = 0; i < keys.length; ++i) {
            keys[i] = keccak256(abi.encode("key", i));
        }
        vm.cool(address(payLink));
        IPayLinkV2.LinkState[] memory states = payLink.statesOf(keys);
        vm.snapshotGasLastFrame(GROUP, "statesOf_256");
        assertEq(states.length, 256);
    }
}
