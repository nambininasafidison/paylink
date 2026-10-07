// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {stdError} from "forge-std/StdError.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {Wallet1271} from "../mocks/Wallet1271.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {NoReturnToken, PermissiveFallbackToken, ReentrantSigner1271} from "./mocks/AuditMocks.sol";

/// @title Audit attack surface: suspected vectors that the contract withstands (regression evidence)
/// @notice Each test is an attack attempt that must fail, or a property that must hold. Unlike BaseTest, which
///         rebuilds digests from the same type strings as the contract, the EIP-712 checks here use Foundry's own
///         typed-data engine (`vm.eip712HashTypedData`) on JSON, so a type-string, field-order or width mistake
///         in the contract would show.
/// @dev Run: forge test --match-path 'test/audit/A03_AttackSurface.t.sol' -vv
contract A03AttackSurfaceTest is BaseTest {
    bytes32 internal constant REF = bytes32("AUDIT");
    uint256 internal constant STATES_SLOT = 3; // `forge inspect PayLinkV2 storageLayout` (see Storage.t.sol)

    // ------------------------------------------------------------------ EIP-712 encoding, independent engine

    function _domainJson(uint256 chainId, address verifyingContract) internal pure returns (string memory) {
        return string.concat(
            '"domain":{"name":"PayLink","version":"2","chainId":',
            vm.toString(chainId),
            ',"verifyingContract":"',
            vm.toString(verifyingContract),
            '"}'
        );
    }

    string internal constant DOMAIN_TYPE =
        '"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}]';

    function _invoiceJson(IPayLinkV2.Invoice memory inv, uint256 chainId, address at)
        internal
        pure
        returns (string memory)
    {
        string memory types = string.concat(
            '{"types":{',
            DOMAIN_TYPE,
            ',"Invoice":[{"name":"payee","type":"address"},{"name":"token","type":"address"},{"name":"amount","type":"uint128"},{"name":"validAfter","type":"uint64"},{"name":"validUntil","type":"uint64"},{"name":"maxPayments","type":"uint32"},{"name":"salt","type":"bytes32"},{"name":"memoHash","type":"bytes32"}]},"primaryType":"Invoice",'
        );
        string memory message = string.concat(
            '"message":{"payee":"',
            vm.toString(inv.payee),
            '","token":"',
            vm.toString(inv.token),
            '","amount":"',
            vm.toString(uint256(inv.amount)),
            '","validAfter":"',
            vm.toString(uint256(inv.validAfter)),
            '","validUntil":"',
            vm.toString(uint256(inv.validUntil)),
            '","maxPayments":"',
            vm.toString(uint256(inv.maxPayments)),
            '","salt":"',
            vm.toString(inv.salt),
            '","memoHash":"',
            vm.toString(inv.memoHash),
            '"}}'
        );
        return string.concat(types, _domainJson(chainId, at), ",", message);
    }

    /// @notice The link id equals Foundry's EIP-712 digest of the spec's type, including at every field's max width.
    function test_Eip712_InvoiceKeyMatchesIndependentEngine() public {
        IPayLinkV2.Invoice memory inv = IPayLinkV2.Invoice({
            payee: payee,
            token: address(usdc),
            amount: type(uint128).max,
            validAfter: type(uint64).max - 1,
            validUntil: type(uint64).max,
            maxPayments: type(uint32).max,
            salt: bytes32(type(uint256).max),
            memoHash: keccak256("memo")
        });
        assertEq(payLink.invoiceKey(inv), vm.eip712HashTypedData(_invoiceJson(inv, block.chainid, address(payLink))));

        inv = _invoice(address(0), 1);
        uint256[3] memory chains = [uint256(10_143), 84_532, 31_611];
        for (uint256 i = 0; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            assertEq(payLink.invoiceKey(inv), vm.eip712HashTypedData(_invoiceJson(inv, chains[i], address(payLink))));
        }
    }

    /// @notice A cancel signed over Foundry's digest of `Cancel(bytes32 key,uint256 deadline)` is accepted.
    function test_Eip712_CancelDigestMatchesIndependentEngine() public {
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        bytes32 key = payLink.invoiceKey(inv);
        uint256 deadline = type(uint256).max;
        string memory json = string.concat(
            '{"types":{',
            DOMAIN_TYPE,
            ',"Cancel":[{"name":"key","type":"bytes32"},{"name":"deadline","type":"uint256"}]},"primaryType":"Cancel",',
            _domainJson(block.chainid, address(payLink)),
            ',"message":{"key":"',
            vm.toString(key),
            '","deadline":"',
            vm.toString(deadline),
            '"}}'
        );
        payLink.cancelBySig(inv, deadline, _sign(payeeKey, vm.eip712HashTypedData(json)));
        assertTrue(payLink.stateOf(key).cancelled);
    }

    // ------------------------------------------------------------------ replay

    /// @notice A payer's EIP-3009 authorization for deployment A cannot settle the same invoice on deployment B
    ///         (same chain, same token, the payee re-signed for B): the nonce's key and the token's `to` differ.
    function test_Replay_3009AuthorizationIsBoundToOneDeployment() public {
        PayLinkV2 other = new PayLinkV2();
        IPayLinkV2.Invoice memory inv = _invoice(address(usdc), USDC_25);
        bytes memory sigB = _sign(payeeKey, _keyFor(inv, block.chainid, address(other)));
        IPayLinkV2.Authorization memory authA = _authorize(payerKey, address(usdc), _key(inv), USDC_25, REF, "s");

        bytes32 nonceB = _nonce(_keyFor(inv, block.chainid, address(other)), payer, USDC_25, REF, "s");
        assertTrue(nonceB != _nonce(_key(inv), payer, USDC_25, REF, "s"), "B recomputes another nonce");

        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        other.payWithAuthorization(inv, sigB, authA);

        // The authorization is still good where it was meant to be used.
        vm.prank(relayer);
        payLink.payWithAuthorization(inv, _signInvoice(inv), authA);
        assertEq(usdc.balanceOf(payee), USDC_25);
    }

    // ------------------------------------------------------------------ ERC-1271 re-entry

    /// @notice A payee whose `isValidSignature` tries to cancel its own link (or anything state-changing) inside the
    ///         check cannot: OZ `SignatureChecker` uses STATICCALL, and the guard is already entered.
    function test_Erc1271_ReentryFromIsValidSignatureChangesNothing() public {
        ReentrantSigner1271 signer = new ReentrantSigner1271();
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 1 ether, 2);
        inv.payee = address(signer);
        bytes32 key = _key(inv);
        signer.arm(address(payLink), abi.encodeCall(payLink.cancel, (inv)));

        vm.prank(payer);
        payLink.payNative{value: 1 ether}(inv, "", REF);

        IPayLinkV2.LinkState memory st = payLink.stateOf(key);
        assertFalse(st.cancelled, "nested cancel had no effect");
        assertEq(st.payments, 1);
        assertEq(address(signer).balance, 1 ether);
    }

    // ------------------------------------------------------------------ token quirks

    /// @notice Phantom permit (WETH9-shaped token): the fallback swallows `permit`, but PayLink pulls only from
    ///         `msg.sender`, so a victim's standing allowance to PayLink cannot be used by anyone else.
    function test_PhantomPermit_VictimAllowanceIsNotSpendableByOthers() public {
        PermissiveFallbackToken weth = new PermissiveFallbackToken();
        address victim = makeAddr("victim");
        weth.mint(victim, 100 ether);
        vm.prank(victim);
        weth.approve(address(payLink), type(uint256).max);

        // The attacker is the payee (signs the invoice) and calls from a second account.
        (address attackerPayee, uint256 attackerPayeeKey) = makeAddrAndKey("attackerPayee");
        IPayLinkV2.Invoice memory inv = _invoice(address(weth), 1 ether);
        inv.payee = attackerPayee;
        bytes memory sig = _sign(attackerPayeeKey, _key(inv));
        IPayLinkV2.Permit memory junk = IPayLinkV2.Permit({deadline: 0, v: 27, r: bytes32(0), s: bytes32(0)});

        vm.prank(stranger);
        vm.expectRevert(bytes("allowance"));
        payLink.payWithPermit(inv, sig, 1 ether, REF, junk);
        vm.prank(stranger);
        vm.expectRevert(bytes("allowance"));
        payLink.pay(inv, sig, 1 ether, REF);
        assertEq(weth.balanceOf(victim), 100 ether, "victim untouched");
    }

    /// @notice Phantom EIP-3009: on the same token `receiveWithAuthorization` also "succeeds" through the fallback
    ///         without moving anything; the exact-receipt check refuses to settle.
    function test_PhantomReceiveWithAuthorization_IsCaughtByReceiptCheck() public {
        PermissiveFallbackToken weth = new PermissiveFallbackToken();
        IPayLinkV2.Invoice memory inv = _invoice(address(weth), 1 ether);
        bytes memory sig = _signInvoice(inv);
        IPayLinkV2.Authorization memory auth;
        auth.payer = makeAddr("victim");
        auth.amount = 1 ether;
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, uint256(1 ether), uint256(0)));
        payLink.payWithAuthorization(inv, sig, auth);
    }

    /// @notice USDT-style tokens without return values settle; a token that returns `false` is refused.
    function test_NoReturnValueToken_SettlesAndFalseIsRefused() public {
        NoReturnToken usdt = new NoReturnToken();
        usdt.mint(payer, 100e6);
        vm.prank(payer);
        usdt.approve(address(payLink), type(uint256).max);
        IPayLinkV2.Invoice memory inv = _invoiceN(address(usdt), 10e6, 0);
        bytes memory sig = _signInvoice(inv);

        vm.prank(payer);
        payLink.pay(inv, sig, 10e6, REF);
        assertEq(usdt.balanceOf(payee), 10e6);

        usdt.setFailQuietly(true);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdt)));
        payLink.pay(inv, sig, 10e6, REF);
    }

    // ------------------------------------------------------------------ packed counters

    function _slotOf(bytes32 key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, STATES_SLOT));
    }

    /// @notice An unlimited link at 2^32 - 1 payments stops accepting payments instead of wrapping `payments`
    ///         (unreachable in practice: ~4.3e9 payments of >= 54k gas each).
    function test_Counters_PaymentsSaturateWithoutWrapping() public {
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 1, 0);
        bytes memory sig = _signInvoice(inv);
        bytes32 key = _key(inv);
        vm.store(address(payLink), _slotOf(key), bytes32(uint256(type(uint32).max)));

        vm.prank(payer);
        vm.expectRevert(stdError.arithmeticError);
        payLink.payNative{value: 1}(inv, sig, REF);
        assertEq(payLink.stateOf(key).payments, type(uint32).max);
    }

    /// @notice `total` (uint128) saturates the same way; neighbouring packed fields are not corrupted.
    function test_Counters_TotalSaturatesWithoutCorruptingPackedFields() public {
        IPayLinkV2.Invoice memory inv = _invoiceN(address(0), 0, 0);
        bytes memory sig = _signInvoice(inv);
        bytes32 key = _key(inv);
        uint256 word = (uint256(type(uint128).max - 5) << 104) | (uint256(1234) << 40) | 7;
        vm.store(address(payLink), _slotOf(key), bytes32(word));

        vm.prank(payer);
        vm.expectRevert(stdError.arithmeticError);
        payLink.payNative{value: 6}(inv, sig, REF);

        vm.prank(payer);
        payLink.payNative{value: 5}(inv, sig, REF);
        IPayLinkV2.LinkState memory st = payLink.stateOf(key);
        assertEq(st.total, type(uint128).max);
        assertEq(st.payments, 8);
        assertFalse(st.cancelled);
        assertEq(st.lastPaidAt, uint64(vm.getBlockTimestamp()));
    }

    // ------------------------------------------------------------------ self-payment

    /// @notice `SelfPayment` compares addresses only: the owner of an ERC-1271 payee can pay it. Not a bypass of any
    ///         security property (the payer's own funds move to an account the payer controls, no fee or reward
    ///         exists, and any second EOA does the same); recorded so nothing downstream treats `SelfPayment` as
    ///         wash-trade protection.
    function test_SelfPaymentGuard_IsAddressEqualityOnly() public {
        Wallet1271 wallet = new Wallet1271(payer);
        IPayLinkV2.Invoice memory inv = _invoice(address(0), 1 ether);
        inv.payee = address(wallet);
        bytes memory sig = _sign(payerKey, _key(inv));
        vm.prank(payer);
        payLink.payNative{value: 1 ether}(inv, sig, REF);
        assertEq(payLink.stateOf(_key(inv)).payments, 1);
    }
}
