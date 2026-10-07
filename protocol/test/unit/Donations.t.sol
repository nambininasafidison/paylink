// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {Donor} from "../mocks/Donor.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Spec §3.3.3 and §5 threat 9: stray balances never brick the contract and are never spent. PayLink never
///         requires `balanceOf(this) == 0`; conservation is relative (I1).
contract DonationsTest is BaseTest {
    Donor internal donor;

    function setUp() public override {
        super.setUp();
        donor = new Donor();
        usdc.mint(address(donor), 1000e6);
        musd.mint(address(donor), 1000e18);
        donor.donate(usdc, address(payLink), 1); // 1 base unit is enough to brick a `== 0` check
        donor.donate(musd, address(payLink), 7e18);
        vm.deal(address(payLink), 3 ether); // forced native (SELFDESTRUCT / coinbase)
    }

    function _assertDonationsIntact() internal view {
        assertEq(usdc.balanceOf(address(payLink)), 1, "usdc donation intact");
        assertEq(musd.balanceOf(address(payLink)), 7e18, "musd donation intact");
        assertEq(address(payLink).balance, 3 ether, "native donation intact");
    }

    function test_EveryPathWorksWithDonationsPresent() public {
        // EIP-3009 pass-through (the only path where funds transit through PayLink).
        IPayLinkV2.Invoice memory a = _invoice(address(usdc), USDC_25);
        payLink.payWithAuthorization(a, _signInvoice(a), _authorize(payerKey, address(usdc), _key(a), USDC_25, "", ""));

        // Allowance.
        IPayLinkV2.Invoice memory b = _invoice(address(musd), 1e18);
        bytes memory sigB = _signInvoice(b);
        vm.startPrank(payer);
        musd.approve(address(payLink), 1e18);
        payLink.pay(b, sigB, 1e18, "");
        vm.stopPrank();

        // Permit.
        IPayLinkV2.Invoice memory c = _invoice(address(musd), 2e18);
        bytes memory sigC = _signInvoice(c);
        IPayLinkV2.Permit memory p = _permit(payerKey, address(musd), 2e18, vm.getBlockTimestamp() + 1 hours);
        vm.prank(payer);
        payLink.payWithPermit(c, sigC, 2e18, "", p);

        // Native.
        IPayLinkV2.Invoice memory d = _invoice(address(0), 1 ether);
        bytes memory sigD = _signInvoice(d);
        vm.prank(payer);
        payLink.payNative{value: 1 ether}(d, sigD, "");

        _assertDonationsIntact();
        assertEq(usdc.balanceOf(payee), USDC_25);
        assertEq(musd.balanceOf(payee), 3e18);
        assertEq(payee.balance, 1 ether);
    }

    /// @notice An invoice for exactly the donated amount cannot be "paid" out of PayLink's own balance: the
    ///         3009 path only forwards what it just received.
    function test_DonationCannotFundAPayment() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), 1);
        IPayLinkV2.Authorization memory auth = _authorize(strangerKey, address(usdc), _key(inv), 1, "", "");
        bytes memory sig = _signInvoice(inv);
        // The stranger holds nothing: the token refuses the pull instead of PayLink forwarding its own balance.
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, stranger, 0, 1));
        payLink.payWithAuthorization(inv, sig, auth);
        _assertDonationsIntact();
    }
}
