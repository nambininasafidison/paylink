// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {Donor} from "../mocks/Donor.sol";
import {FeeOnTransfer} from "../mocks/FeeOnTransfer.sol";
import {Mock3009} from "../mocks/Mock3009.sol";
import {MockPermit} from "../mocks/MockPermit.sol";
import {OverCreditToken} from "../mocks/OverCreditToken.sol";
import {Wallet1271} from "../mocks/Wallet1271.sol";
import {GhostLedger, WALLET_PAYEE} from "./GhostLedger.sol";

/// @title Handler: model-based action set for the PayLinkV2 invariant campaign (spec §3.3.4)
/// @notice Three actors (each both payer and payee), an ERC-1271 wallet payee, a relayer, a donor, six assets
///         (Mock3009, MockPermit, two FeeOnTransfer tokens, an OverCreditToken, native) and an alternate PayLinkV2
///         deployment.
///         The two fee tokens reach different guards: `fee` charges on every leg, so EIP-3009 attempts stop at the
///         receive-delta check; `fwdFee` exempts PayLink as a recipient, so EIP-3009 attempts receive in full and
///         reach the forward leg, where it either deducts the fee from the payee's credit (`_pushExact`:
///         `PayeeShortPaid`) or charges PayLink on top (the conservation post-check: `ReceivedMismatch`, paid out of
///         stray donations if the post-check were missing). `reconfigureFee` switches it between the two modes.
///         Fee tokens only ever make a balance come up short. I1 and I6 are equalities, so `overCredit` covers the
///         other direction: `reconfigureOverCredit` arms one leg to move *more* than the amount (PayLink credited
///         extra on the receive leg, the payee credited extra on a pull or on the forward leg, or PayLink debited
///         less on the forward leg, which would leave PayLink's balance above where it started).
///         Callers are not always their own transaction origin: payments, `cancel` and `cancelBySig` run under a
///         seeded `tx.origin` (often the payee itself), so a check that trusted `tx.origin` (SWC-115) would show
///         up as an I9 violation or a model disagreement.
///         Every action:
///         1. predicts the outcome with an independent model of the contract (expected success, or the exact
///            revert data);
///         2. performs the call with a low-level `call`, so the handler itself never reverts (fail_on_revert is
///            on: any revert means a handler bug);
///         3. decodes the emitted logs into the GhostLedger and checks the per-call properties (I1, I4, I5, I6,
///            I7, I8, I9, I10) and the model agreement;
///         4. checks I11 (monotonic state) and model/state equality for every known key.
///         Violations are recorded per invariant ID and asserted by `Invariants.t.sol`.
contract Handler is Test {
    enum Path {
        Authorization,
        Allowance,
        Permit,
        Native
    }

    /// @dev Invoices kept live for payments; past it, new invoices are only created while fewer than
    ///      `MIN_LIVE` are still payable, up to `HARD_CAP` (every invoice stays checked by the invariants).
    uint256 public constant MAX_ENTRIES = 24;
    uint256 public constant MIN_LIVE = 4;
    uint256 public constant HARD_CAP = 64;
    uint256 public constant FEE_BPS = 100;
    uint256 internal constant N_ACTORS = 3;
    uint256 internal constant N_ASSETS = 6;
    uint256 internal constant N_BALANCES = 8;
    uint256 internal constant SEED_DONATION = 5e5;
    /// @dev Largest over-credit `reconfigureOverCredit` arms (in base units); the smallest is 1.
    uint256 internal constant MAX_BONUS = 1e6;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 key,uint256 deadline)");
    bytes32 internal constant INVOICE_TYPEHASH = keccak256(
        "Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)"
    );
    bytes32 internal constant PAYMENT_BINDING_TYPEHASH =
        keccak256("PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)");
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    PayLinkV2 public immutable payLink;
    PayLinkV2 public immutable alt;
    GhostLedger public immutable ghost;
    Mock3009 public immutable usdc;
    MockPermit public immutable musd;
    FeeOnTransfer public immutable fee;
    FeeOnTransfer public immutable fwdFee;
    OverCreditToken public immutable overCredit;
    Wallet1271 public immutable wallet;
    Donor public immutable donor;
    address public immutable relayer;

    address[N_ACTORS] public actors;
    uint256[N_ACTORS] internal _keys;

    uint256 internal _nonce;

    constructor(PayLinkV2 payLink_, PayLinkV2 alt_) {
        payLink = payLink_;
        alt = alt_;
        ghost = new GhostLedger();
        usdc = new Mock3009("Mock USD Coin", "mUSDC", "2", 6);
        musd = new MockPermit("Mock Mezo USD", "mMUSD");
        fee = new FeeOnTransfer(FEE_BPS, FeeOnTransfer.FeeMode.DeductFromAmount);
        fwdFee = new FeeOnTransfer(FEE_BPS, FeeOnTransfer.FeeMode.ChargeSender);
        fwdFee.setExempt(address(payLink_), true); // full receipt; the fee falls on the forward leg
        overCredit = new OverCreditToken();
        overCredit.arm(OverCreditToken.Mode.None, address(payLink_), 0); // standard until reconfigureOverCredit
        donor = new Donor();
        relayer = makeAddr("relayer");
        for (uint256 i = 0; i < N_ACTORS; ++i) {
            (actors[i], _keys[i]) = makeAddrAndKey(string.concat("actor", vm.toString(i)));
        }
        wallet = new Wallet1271(actors[0]);

        // Seed one live invoice per asset (one of them to the ERC-1271 wallet), so payments start immediately.
        for (uint256 a = 0; a < N_ASSETS; ++a) {
            _create(a == 1 ? WALLET_PAYEE : a % N_ACTORS, GhostLedger.Asset(a), 0, 0, 0, 0);
        }
        // Seed a stray balance of the forward-fee token, so a charge on PayLink's forward leg is payable out of
        // donations from the first run on; `donate` adds more.
        fwdFee.mint(address(donor), SEED_DONATION);
        donor.donate(MockPermit(address(fwdFee)), address(payLink_), SEED_DONATION);
        ghost.recordDonation(address(fwdFee), SEED_DONATION);
        // Same for the over-credit token, so a conservation failure reports (stray, stray + bonus), never (0, bonus),
        // and is told apart from a receive-check failure, which reports (amount, amount + bonus).
        overCredit.mint(address(donor), SEED_DONATION);
        donor.donate(MockPermit(address(overCredit)), address(payLink_), SEED_DONATION);
        ghost.recordDonation(address(overCredit), SEED_DONATION);
    }

    // ================================================================== actions: invoices and time

    function createInvoice(
        uint256 payeeSeed,
        uint256 assetSeed,
        uint256 amountSeed,
        uint256 windowSeed,
        uint256 maxSeed
    ) external {
        ghost.countCall("createInvoice");
        uint256 n = ghost.entryCount();
        if (n >= HARD_CAP || (n >= MAX_ENTRIES && _liveCount() >= MIN_LIVE)) return;
        uint256 payeeActor = payeeSeed % 4 == 3 ? WALLET_PAYEE : payeeSeed % N_ACTORS;
        _create(payeeActor, GhostLedger.Asset(assetSeed % N_ASSETS), amountSeed, windowSeed, maxSeed, 1);
    }

    function warp(uint256 secondsSeed) external {
        ghost.countCall("warp");
        uint256[N_BALANCES] memory before = _balances();
        // Mostly short steps, so links stay payable; one in eight jumps up to 3 days, past most windows.
        uint256 step =
            _mix(secondsSeed, "warp") % 8 == 0 ? _bound(secondsSeed, 0, 3 days) : _bound(secondsSeed, 0, 6 hours);
        vm.warp(vm.getBlockTimestamp() + step);
        vm.roll(vm.getBlockNumber() + 1);
        _afterAction("warp", before);
    }

    // ================================================================== actions: payments

    function payWithAuthorization(uint256 invSeed, uint256 payerSeed, uint256 amountSeed) external {
        ghost.countCall("payWithAuthorization");
        (bool found, uint256 idx) = _pick(invSeed, Path.Authorization);
        if (!found) return;
        _attempt(Path.Authorization, idx, payerSeed, amountSeed, false);
    }

    function pay(uint256 invSeed, uint256 payerSeed, uint256 amountSeed) external {
        ghost.countCall("pay");
        (bool found, uint256 idx) = _pick(invSeed, Path.Allowance);
        if (!found) return;
        _attempt(Path.Allowance, idx, payerSeed, amountSeed, false);
    }

    function payWithPermit(uint256 invSeed, uint256 payerSeed, uint256 amountSeed, bool frontRun) external {
        ghost.countCall("payWithPermit");
        (bool found, uint256 idx) = _pick(invSeed, Path.Permit);
        if (!found) return;
        _attempt(Path.Permit, idx, payerSeed, amountSeed, frontRun);
    }

    function payNative(uint256 invSeed, uint256 payerSeed, uint256 amountSeed) external {
        ghost.countCall("payNative");
        (bool found, uint256 idx) = _pick(invSeed, Path.Native);
        if (!found) return;
        _attempt(Path.Native, idx, payerSeed, amountSeed, false);
    }

    // ================================================================== actions: revocation (I9)

    /// @dev I9 is about `msg.sender`: the transaction origin is seeded independently of the caller and is often the
    ///      payee itself (a payee lured into calling someone else's contract, SWC-115), on the direct path and on the
    ///      wallet path alike.
    function cancel(uint256 invSeed, uint256 callerSeed, uint256 originSeed) external {
        ghost.countCall("cancel");
        uint256 n = ghost.entryCount();
        GhostLedger.Entry memory e = ghost.entry(invSeed % n);
        uint256 c = callerSeed % (N_ACTORS + 1);
        address caller = c == N_ACTORS ? address(wallet) : actors[c];
        address origin;
        if (c == N_ACTORS) {
            // The call into the wallet comes from its owner: the origin is the owner, or an EOA payee whose
            // transaction ends up making the wallet call `cancel`.
            bool ownerOrigin = _mix(originSeed, "wallet-origin") % 2 == 0 || e.payeeActor == WALLET_PAYEE;
            origin = ownerOrigin ? actors[0] : e.inv.payee;
        } else {
            origin = _originFor(e, originSeed, caller);
        }

        bytes memory expected;
        if (caller != e.inv.payee) expected = abi.encodeWithSelector(IPayLinkV2.NotPayee.selector);
        else if (ghost.model(e.key).cancelled) expected = abi.encodeWithSelector(IPayLinkV2.Cancelled.selector);

        uint256[N_BALANCES] memory before = _balances();
        vm.recordLogs();
        bool ok;
        bytes memory ret;
        if (c == N_ACTORS) {
            vm.prank(actors[0], origin); // the wallet's owner makes the wallet call cancel
            (ok, ret) = address(wallet)
                .call(abi.encodeCall(wallet.execute, (address(payLink), 0, abi.encodeCall(payLink.cancel, (e.inv)))));
        } else {
            vm.prank(caller, origin);
            (ok, ret) = address(payLink).call(abi.encodeCall(payLink.cancel, (e.inv)));
        }
        _processLogs("cancel", ok);
        _compare("cancel", expected.length == 0, expected, ok, ret);

        if (ok) {
            if (caller != e.inv.payee) {
                _violation(
                    9,
                    origin == e.inv.payee
                        ? "cancel: succeeded for a caller other than the payee (tx.origin was the payee)"
                        : "cancel: succeeded for a caller other than the payee"
                );
            }
            _markCancelled(e.key);
        }
        _afterAction("cancel", before);
    }

    function cancelBySig(uint256 invSeed, uint256 signerSeed, uint256 deadlineSeed) external {
        ghost.countCall("cancelBySig");
        uint256 n = ghost.entryCount();
        GhostLedger.Entry memory e = ghost.entry(invSeed % n);
        uint256 signer = signerSeed % N_ACTORS;
        uint256 expectedSigner = e.payeeActor == WALLET_PAYEE ? 0 : e.payeeActor;
        uint256 nowTs = vm.getBlockTimestamp();
        uint256 deadline = nowTs - 6 hours + (deadlineSeed % 1 days); // a quarter of them already expired
        bytes memory sig = _sign(_keys[signer], _cancelDigest(address(payLink), e.key, deadline));

        bytes memory expected;
        if (nowTs > deadline) expected = abi.encodeWithSelector(IPayLinkV2.SignatureExpired.selector, deadline);
        else if (ghost.model(e.key).cancelled) expected = abi.encodeWithSelector(IPayLinkV2.Cancelled.selector);
        else if (signer != expectedSigner) expected = abi.encodeWithSelector(IPayLinkV2.InvalidSignature.selector);

        uint256[N_BALANCES] memory before = _balances();
        vm.recordLogs();
        // Relayed, sometimes from a transaction the payee itself originated: that must not stand in for a signature.
        vm.prank(relayer, _originFor(e, deadlineSeed, relayer));
        (bool ok, bytes memory ret) = address(payLink).call(abi.encodeCall(payLink.cancelBySig, (e.inv, deadline, sig)));
        _processLogs("cancelBySig", ok);
        _compare("cancelBySig", expected.length == 0, expected, ok, ret);

        if (ok) {
            if (signer != expectedSigner) _violation(9, "cancelBySig: accepted a signature not from the payee");
            _markCancelled(e.key);
        }
        _afterAction("cancelBySig", before);
    }

    /// @notice Switches the forward-fee token between its two fee models (PayLink stays exempt as a recipient):
    ///         `ChargeSender` makes the forward leg cost PayLink `amount + fee`, `DeductFromAmount` credits the
    ///         payee `amount - fee`.
    function reconfigureFee(bool chargeSender) external {
        ghost.countCall("reconfigureFee");
        uint256[N_BALANCES] memory before = _balances();
        fwdFee.setFee(
            FEE_BPS, chargeSender ? FeeOnTransfer.FeeMode.ChargeSender : FeeOnTransfer.FeeMode.DeductFromAmount
        );
        _afterAction("reconfigureFee", before);
    }

    /// @notice Arms the over-credit token on one leg (or disarms it), with an extra of 1 to `MAX_BONUS` base units
    ///         (1 one time in four, the smallest step an exactness check must still see):
    ///         - `BonusOnReceive`: PayLink credited `amount + bonus` by the EIP-3009 receive (PayLink's balance would
    ///           grow: I1);
    ///         - `BonusOnPull`: the payee credited `amount + bonus` on the allowance and permit paths (I6);
    ///         - `BonusOnPush`: the payee credited `amount + bonus` by the EIP-3009 forward (I6);
    ///         - `UnderDebitOnPush`: PayLink debited `amount - bonus` by the EIP-3009 forward (I1);
    ///         - `None`: standard.
    function reconfigureOverCredit(uint256 modeSeed, uint256 bonusSeed) external {
        ghost.countCall("reconfigureOverCredit");
        uint256[N_BALANCES] memory before = _balances();
        uint256 bonus = bonusSeed % 4 == 0 ? 1 : _bound(_mix(bonusSeed, "bonus"), 1, MAX_BONUS);
        overCredit.arm(OverCreditToken.Mode(modeSeed % 5), address(payLink), bonus);
        _afterAction("reconfigureOverCredit", before);
    }

    // ================================================================== actions: stray transfers

    function donate(uint256 assetSeed, uint256 amountSeed) external {
        ghost.countCall("donate");
        GhostLedger.Asset asset = GhostLedger.Asset(assetSeed % N_ASSETS);
        uint256 amount = _bound(amountSeed, 1, 1e6);
        address token = _tokenOf(asset);
        uint256 balanceBefore = _balanceOf(asset, address(payLink));
        if (asset == GhostLedger.Asset.Native) {
            vm.deal(address(payLink), balanceBefore + amount); // forced: SELFDESTRUCT or coinbase
        } else {
            Mock3009(token).mint(address(donor), amount);
            donor.donate(MockPermit(token), address(payLink), amount);
        }
        // FeeOnTransfer delivers less than sent: record what actually arrived.
        ghost.recordDonation(token, _balanceOf(asset, address(payLink)) - balanceBefore);
        _afterAction("donate", _balances());
    }

    // ================================================================== actions: attacks

    /// @notice I8: a relayer holding a valid authorization mutates the payment tuple before submitting.
    function relayerRedirect(uint256 invSeed, uint256 payerSeed, uint256 amountSeed, uint256 mutation) external {
        ghost.countCall("relayerRedirect");
        (bool found, uint256 idx) = _pick(invSeed, Path.Authorization);
        if (!found) return;
        (bool ready, GhostLedger.Entry memory target, IPayLinkV2.Authorization memory auth) =
            _forgeAuthorization(idx, _payerFor(ghost.entry(idx), payerSeed), amountSeed, mutation);
        if (!ready) return;

        // PayLink's own checks run first; whenever they pass, the token must reject the signature.
        (bool expectOk, bytes memory expected) = _predict(target, Path.Authorization, auth.payer, auth.amount);
        if (expectOk || _isTokenSide(expected)) {
            expected = abi.encodeWithSignature("Error(string)", "FiatTokenV2: invalid signature");
        }

        uint256[N_BALANCES] memory before = _balances();
        vm.recordLogs();
        vm.prank(relayer);
        (bool ok, bytes memory ret) =
            address(payLink).call(abi.encodeCall(payLink.payWithAuthorization, (target.inv, target.sig, auth)));
        _processLogs("relayerRedirect", ok);
        if (ok) _violation(8, "relayerRedirect: a mutated authorization settled");
        _compare("relayerRedirect", false, expected, ok, ret);
        _afterAction("relayerRedirect", before);
    }

    /// @dev Signs an honest authorization for entry `idx`, then applies the relayer's forgery: one field of the
    ///      tuple (amount, payerRef, payerSalt, payer, validBefore), or another link of the same token.
    function _forgeAuthorization(uint256 idx, uint256 payerIdx, uint256 amountSeed, uint256 mutation)
        internal
        returns (bool ready, GhostLedger.Entry memory target, IPayLinkV2.Authorization memory auth)
    {
        target = ghost.entry(idx);
        if (!_fits(target.asset, Path.Authorization)) return (false, target, auth);
        uint128 amount =
            target.inv.amount != 0 ? target.inv.amount : uint128(_bound(amountSeed, 1, _maxAmount(target.asset)));
        address token = _tokenOf(target.asset);
        auth = _authorize(
            payerIdx,
            token,
            address(payLink),
            target.key,
            amount,
            keccak256(abi.encode("ref", ++_nonce)),
            keccak256(abi.encode("salt", _nonce))
        );
        Mock3009(token).mint(auth.payer, amount + 1);

        uint256 field = mutation % 6;
        if (field == 0) {
            auth.amount = amount + 1;
        } else if (field == 1) {
            auth.payerRef = bytes32(uint256(auth.payerRef) ^ 1);
        } else if (field == 2) {
            auth.payerSalt = bytes32(uint256(auth.payerSalt) ^ 1);
        } else if (field == 3) {
            auth.payer = actors[(payerIdx + 1 + _mix(mutation, "payer") % (N_ACTORS - 1)) % N_ACTORS];
            Mock3009(token).mint(auth.payer, amount + 1);
        } else if (field == 4) {
            auth.validBefore += 1;
        } else {
            uint256 other = _otherEntryOfAsset(idx, target.asset, _mix(mutation, "link"));
            if (other == idx) return (false, target, auth);
            target = ghost.entry(other);
        }
        ready = true;
    }

    /// @notice I7: signatures replayed on an alternate deployment or under another chain id.
    function crossDomainReplay(uint256 invSeed, uint256 payerSeed, uint256 mode, uint256 chainSeed) external {
        ghost.countCall("crossDomainReplay");
        uint256 n = ghost.entryCount();
        GhostLedger.Entry memory e = ghost.entry(invSeed % n);
        address payerAddr = actors[payerSeed % N_ACTORS];
        if (payerAddr == e.inv.payee) payerAddr = actors[(payerSeed % N_ACTORS + 1) % N_ACTORS];
        mode = mode % 4;
        uint256 homeChain = vm.getChainId();
        uint256[4] memory chains = [uint256(10_143), 84_532, 421_614, 31_611];
        uint256 otherChain = chains[chainSeed % 4];
        if (otherChain == homeChain) otherChain = 1;

        uint256[N_BALANCES] memory before = _balances();
        PayLinkV2 target = mode % 2 == 0 ? alt : payLink;
        bytes memory data;
        if (mode < 2) {
            // A payment signed for (home chain, payLink), fully funded so that acceptance would be observable.
            uint128 amount = e.inv.amount != 0 ? e.inv.amount : 1;
            if (e.asset == GhostLedger.Asset.Native) {
                vm.deal(payerAddr, payerAddr.balance + amount);
                data = abi.encodeCall(payLink.payNative, (e.inv, e.sig, "replay"));
            } else {
                Mock3009(_tokenOf(e.asset)).mint(payerAddr, amount);
                vm.prank(payerAddr);
                MockPermit(_tokenOf(e.asset)).approve(address(target), amount);
                data = abi.encodeCall(payLink.pay, (e.inv, e.sig, amount, "replay"));
            }
            vm.recordLogs();
            if (mode == 1) vm.chainId(otherChain);
            vm.prank(payerAddr);
            (bool ok, bytes memory ret) =
                address(target).call{value: e.asset == GhostLedger.Asset.Native ? amount : 0}(data);
            vm.chainId(homeChain);
            _processLogs("crossDomainReplay", ok);
            if (ok) _violation(7, "crossDomainReplay: a payee signature verified under a foreign domain");
            _compare("crossDomainReplay", false, abi.encodeWithSelector(IPayLinkV2.InvalidSignature.selector), ok, ret);
        } else {
            // A cancel signed by the right payee for (home chain, payLink).
            uint256 signer = e.payeeActor == WALLET_PAYEE ? 0 : e.payeeActor;
            uint256 deadline = vm.getBlockTimestamp() + 1 days;
            bytes memory sig = _sign(_keys[signer], _cancelDigest(address(payLink), e.key, deadline));
            vm.recordLogs();
            if (mode == 3) vm.chainId(otherChain);
            (bool ok, bytes memory ret) =
                address(target).call(abi.encodeCall(payLink.cancelBySig, (e.inv, deadline, sig)));
            vm.chainId(homeChain);
            _processLogs("crossDomainReplay", ok);
            if (ok) _violation(7, "crossDomainReplay: a cancel signature verified under a foreign domain");
            _compare("crossDomainReplay", false, abi.encodeWithSelector(IPayLinkV2.InvalidSignature.selector), ok, ret);
        }
        _afterAction("crossDomainReplay", before);
    }

    /// @notice I10: wrong entry point for the token kind, plain transfers and unknown calls.
    function wrongPath(uint256 invSeed, uint256 payerSeed, uint256 mode) external {
        ghost.countCall("wrongPath");
        address payerAddr = actors[payerSeed % N_ACTORS];
        mode = mode % 6;
        bytes memory data;
        uint256 value;
        if (mode == 0) {
            value = 1; // plain native transfer -> receive()
        } else if (mode == 1) {
            data = abi.encodeWithSignature("sweep(address)", payerAddr); // unknown selector -> fallback()
            value = 1;
        } else {
            (bool found, uint256 idx) = _pick(invSeed, mode == 5 ? Path.Allowance : Path.Native);
            if (!found) return;
            GhostLedger.Entry memory e = ghost.entry(idx);
            bool isNative = e.asset == GhostLedger.Asset.Native;
            if ((mode == 5) == isNative) return; // modes 2-4 need a native invoice, mode 5 an ERC-20 one
            IPayLinkV2.Authorization memory auth;
            IPayLinkV2.Permit memory p;
            if (mode == 2) data = abi.encodeCall(payLink.pay, (e.inv, e.sig, 1, ""));
            else if (mode == 3) data = abi.encodeCall(payLink.payWithPermit, (e.inv, e.sig, 1, "", p));
            else if (mode == 4) data = abi.encodeCall(payLink.payWithAuthorization, (e.inv, e.sig, auth));
            else (data, value) = (abi.encodeCall(payLink.payNative, (e.inv, e.sig, "")), 1);
        }
        vm.deal(payerAddr, payerAddr.balance + value);
        uint256[N_BALANCES] memory before = _balances();
        vm.recordLogs();
        vm.prank(payerAddr);
        (bool ok, bytes memory ret) = address(payLink).call{value: value}(data);
        _processLogs("wrongPath", ok);
        if (ok) _violation(10, "wrongPath: a call through the wrong path succeeded");
        _compare("wrongPath", false, abi.encodeWithSelector(IPayLinkV2.WrongPaymentPath.selector), ok, ret);
        // The refunded value is not PayLink's: compare balances excluding the reverted call.
        _afterAction("wrongPath", before);
    }

    // ================================================================== core: one payment attempt

    struct Attempt {
        Path path;
        uint256 idx;
        uint256 payerIdx;
        address payer;
        uint128 amount;
        bool expectOk;
        bytes expected;
        uint256 payeeBefore;
        uint256 payerBefore;
        uint32 expectedIndex;
        bytes32 payerRef;
        bytes32 payerSalt;
        uint256 surcharge; // fee a ChargeSender token takes from the payer on top of `amount` (allowance paths)
    }

    /// @dev Fields of the last `Paid` decoded from a successful call.
    struct PaidLog {
        bytes32 key;
        address payee;
        address payer;
        address token;
        uint128 amount;
        uint32 index;
        bytes32 payerRef;
    }

    function _attempt(Path path, uint256 idx, uint256 payerSeed, uint256 amountSeed, bool frontRun) internal {
        GhostLedger.Entry memory e = ghost.entry(idx);
        Attempt memory a;
        a.path = path;
        a.idx = idx;
        a.payerIdx = _payerFor(e, payerSeed);
        a.payer = actors[a.payerIdx];
        a.amount = _amountFor(e, amountSeed);
        (a.expectOk, a.expected) = _predict(e, path, a.payer, a.amount);
        a.expectedIndex = ghost.model(e.key).payments;

        bytes memory data = _prepare(e, a, frontRun);

        uint256[N_BALANCES] memory before = _balances();
        a.payeeBefore = _balanceOf(e.asset, e.inv.payee);
        a.payerBefore = _balanceOf(e.asset, a.payer);
        vm.recordLogs();
        _prankSender(e, a, payerSeed);
        (bool ok, bytes memory ret) = address(payLink).call{value: path == Path.Native ? uint256(a.amount) : 0}(data);
        string memory label = string.concat(_pathName(path), " [", _assetName(e.asset), "]");
        (uint256 paidCount, PaidLog memory paid) = _processLogs(label, ok);
        _compare(label, a.expectOk, a.expected, ok, ret);

        if (ok) {
            _checkPaidEvent(label, e, a, paidCount, paid);
            bool native = e.asset == GhostLedger.Asset.Native;
            if (native != (path == Path.Native)) {
                _violation(10, string.concat(label, ": settled through the wrong path"));
            }
            if (abi.decode(ret, (uint32)) != a.expectedIndex) _violation(0, string.concat(label, ": wrong index"));
            _checkSettledDeltas(label, e, a);
            GhostLedger.Model memory m = ghost.model(e.key);
            m.payments += 1;
            m.total += a.amount;
            m.lastPaidAt = uint64(vm.getBlockTimestamp());
            ghost.setModel(e.key, m);
        }
        _afterAction(label, before);
    }

    /// @dev Exactly one `Paid` per settled payment, carrying the attempt's fields (I3, I6). For EIP-3009 payments
    ///      the token must have consumed exactly the nonce bound to (key, payer, amount, payerRef, payerSalt),
    ///      computed here independently of PayLink (I8).
    function _checkPaidEvent(
        string memory label,
        GhostLedger.Entry memory e,
        Attempt memory a,
        uint256 paidCount,
        PaidLog memory paid
    ) internal {
        if (paidCount != 1) {
            return _violation(3, string.concat(label, ": settled with other than one Paid event"));
        }
        if (
            paid.key != e.key || paid.payer != a.payer || paid.amount != a.amount || paid.index != a.expectedIndex
                || paid.payerRef != a.payerRef
        ) _violation(3, string.concat(label, ": Paid fields differ from the payment"));
        if (a.path == Path.Authorization) {
            bytes32 bound = _boundNonce(e.key, a.payer, a.amount, a.payerRef, a.payerSalt);
            if (!Mock3009(_tokenOf(e.asset)).authorizationState(a.payer, bound)) {
                _violation(8, string.concat(label, ": the token did not consume the bound nonce"));
            }
        }
    }

    /// @dev Checks for a payment that settled: the payee gained exactly `amount` and the payer lost exactly `amount`
    ///      (I6, both as equalities), and the token was not one that must never settle on this path (I1, I6).
    function _checkSettledDeltas(string memory label, GhostLedger.Entry memory e, Attempt memory a) internal {
        if (e.asset == GhostLedger.Asset.FeeToken) {
            _violation(6, string.concat(label, ": a fee-on-transfer payment settled"));
        }
        if (_balanceOf(e.asset, e.inv.payee) != a.payeeBefore + a.amount) {
            _violation(6, string.concat(label, ": payee delta != amount"));
        }
        // A token that charges the sender on top debits the payer `amount + fee`; PayLink itself moves `amount`.
        if (_balanceOf(e.asset, a.payer) + a.amount + a.surcharge != a.payerBefore) {
            _violation(6, string.concat(label, ": payer delta != amount (+ the token's own sender fee)"));
        }
        if (e.asset == GhostLedger.Asset.ForwardFee && a.path == Path.Authorization) {
            // Charging PayLink would spend donations (I1); deducting from the payee's credit short-pays it (I6).
            if (_chargesSender()) {
                _violation(1, string.concat(label, ": settled although the token charged PayLink's forward leg"));
            } else {
                _violation(6, string.concat(label, ": settled although the forward leg short-paid the payee"));
            }
        }
        if (e.asset == GhostLedger.Asset.OverCredit) _checkOverCreditSettlement(label, a.path);
    }

    /// @dev Pranks the next call as the attempt's sender (the relayer for EIP-3009, the payer otherwise) under a seeded
    ///      transaction origin. The payer is `msg.sender` (or `auth.payer` when relayed), so an origin that is the
    ///      payee, another actor or the relayer must change nothing (SWC-115).
    function _prankSender(GhostLedger.Entry memory e, Attempt memory a, uint256 seed) internal {
        address sender = a.path == Path.Authorization ? relayer : a.payer;
        vm.prank(sender, _originFor(e, seed, sender));
    }

    /// @dev A payment on the over-credit token settled: legitimate only when the armed leg is not one this path uses.
    ///      PayLink credited extra on the receive leg, or debited less on the forward leg, would leave its balance
    ///      above where it started (I1); the payee credited extra breaks the payee delta (I6). The per-call balance
    ///      and delta checks see the same thing; this names the leg.
    function _checkOverCreditSettlement(string memory label, Path path) internal {
        OverCreditToken.Mode m = overCredit.mode();
        if (path == Path.Authorization) {
            if (m == OverCreditToken.Mode.BonusOnReceive) {
                _violation(1, string.concat(label, ": settled although PayLink received more than the amount"));
            } else if (m == OverCreditToken.Mode.UnderDebitOnPush) {
                _violation(1, string.concat(label, ": settled although the forward leg debited PayLink less"));
            } else if (m == OverCreditToken.Mode.BonusOnPush) {
                _violation(6, string.concat(label, ": settled although the forward leg over-credited the payee"));
            }
        } else if (m == OverCreditToken.Mode.BonusOnPull) {
            _violation(6, string.concat(label, ": settled although transferFrom over-credited the payee"));
        }
    }

    /// @dev Funds the payer and builds the calldata (authorization, approval or permit) for one attempt.
    function _prepare(GhostLedger.Entry memory e, Attempt memory a, bool frontRun) internal returns (bytes memory) {
        bytes32 payerRef = keccak256(abi.encode("ref", ++_nonce));
        a.payerRef = payerRef;
        a.payerSalt = keccak256(abi.encode("salt", _nonce));
        if (a.path == Path.Native) {
            vm.deal(a.payer, a.payer.balance + a.amount);
            return abi.encodeCall(payLink.payNative, (e.inv, e.sig, payerRef));
        }
        address token = _tokenOf(e.asset);
        if (token == address(0)) {
            // Native invoice reached an ERC-20 path (WrongPaymentPath is expected): any token will do.
            token = address(usdc);
        }
        if (e.asset == GhostLedger.Asset.ForwardFee && a.path != Path.Authorization && _chargesSender()) {
            a.surcharge = _feeOf(a.amount);
        }
        Mock3009(token).mint(a.payer, a.amount + a.surcharge);
        if (a.path == Path.Authorization) {
            IPayLinkV2.Authorization memory auth = _authorize(
                a.payerIdx, token, address(payLink), e.key, a.amount, payerRef, keccak256(abi.encode("salt", _nonce))
            );
            return abi.encodeCall(payLink.payWithAuthorization, (e.inv, e.sig, auth));
        }
        if (a.path == Path.Allowance) {
            vm.prank(a.payer);
            MockPermit(token).approve(address(payLink), a.amount);
            return abi.encodeCall(payLink.pay, (e.inv, e.sig, a.amount, payerRef));
        }
        IPayLinkV2.Permit memory p = _permit(a.payerIdx, token, a.amount);
        if (frontRun) {
            // Spec §5 threat 10: a griefer submits the permit first. The payment must not care.
            vm.prank(actors[(a.payerIdx + 1) % N_ACTORS]);
            (bool ok,) = token.call(
                abi.encodeCall(IERC20Permit.permit, (a.payer, address(payLink), a.amount, p.deadline, p.v, p.r, p.s))
            );
            if (!ok) _violation(0, "payWithPermit: front-run permit unexpectedly failed");
        }
        return abi.encodeCall(payLink.payWithPermit, (e.inv, e.sig, a.amount, payerRef, p));
    }

    // ================================================================== model

    /// @dev Expected outcome of a payment, in the contract's documented check order. Invoices are well-formed and
    ///      signed under the home domain, and the wallet payee never rotates its owner, so shape and signature
    ///      checks pass by construction (they are covered by unit and fuzz tests).
    function _predict(GhostLedger.Entry memory e, Path path, address payerAddr, uint128 amount)
        internal
        view
        returns (bool ok, bytes memory err)
    {
        if ((e.asset == GhostLedger.Asset.Native) != (path == Path.Native)) {
            return (false, abi.encodeWithSelector(IPayLinkV2.WrongPaymentPath.selector));
        }
        GhostLedger.Model memory m = ghost.model(e.key);
        uint256 nowTs = vm.getBlockTimestamp();
        if (m.cancelled) return (false, abi.encodeWithSelector(IPayLinkV2.Cancelled.selector));
        if (nowTs < e.inv.validAfter) {
            return (false, abi.encodeWithSelector(IPayLinkV2.NotYetValid.selector, e.inv.validAfter));
        }
        if (e.inv.validUntil != 0 && nowTs > e.inv.validUntil) {
            return (false, abi.encodeWithSelector(IPayLinkV2.Expired.selector, e.inv.validUntil));
        }
        if (e.inv.maxPayments != 0 && m.payments >= e.inv.maxPayments) {
            return (false, abi.encodeWithSelector(IPayLinkV2.SoldOut.selector, e.inv.maxPayments));
        }
        if (e.inv.amount == 0 ? amount == 0 : amount != e.inv.amount) {
            return (false, abi.encodeWithSelector(IPayLinkV2.WrongAmount.selector, e.inv.amount, amount));
        }
        if (payerAddr == e.inv.payee) return (false, abi.encodeWithSelector(IPayLinkV2.SelfPayment.selector));
        if (e.asset == GhostLedger.Asset.FeeToken) {
            uint256 feeAmount = _feeOf(amount);
            if (path == Path.Authorization) {
                return (false, abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, amount, amount - feeAmount));
            }
            return (false, abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, amount, amount - feeAmount));
        }
        if (e.asset == GhostLedger.Asset.ForwardFee) return _predictForwardFee(path, amount);
        if (e.asset == GhostLedger.Asset.OverCredit) return _predictOverCredit(path, amount);
        if (path == Path.Authorization && e.asset == GhostLedger.Asset.MusdPermit) {
            return (false, ""); // the token has no receiveWithAuthorization: empty revert
        }
        return (true, "");
    }

    /// @dev Over-credit token, deterministic from the armed leg, the bonus and the stray balance. Each exactness check
    ///      is an equality, so a delta *above* the amount reports the same documented errors as a shortfall:
    ///      - EIP-3009 path: `BonusOnReceive` -> the receive check, `ReceivedMismatch(amount, amount + bonus)`;
    ///        `BonusOnPush` -> `_pushExact`, `PayeeShortPaid(amount, amount + bonus)`; `UnderDebitOnPush` -> the
    ///        conservation post-check, `ReceivedMismatch(stray, stray + bonus)`; `None` and `BonusOnPull` touch no
    ///        leg of this path, so the payment settles;
    ///      - allowance and permit paths (payer -> payee, PayLink never holds the funds): `BonusOnPull` ->
    ///        `_pullExact`, `PayeeShortPaid(amount, amount + bonus)`; every other mode settles.
    function _predictOverCredit(Path path, uint128 amount) internal view returns (bool ok, bytes memory err) {
        OverCreditToken.Mode m = overCredit.mode();
        uint256 bonus = overCredit.bonus();
        if (path == Path.Authorization) {
            if (m == OverCreditToken.Mode.BonusOnReceive) {
                return (false, abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, amount, amount + bonus));
            }
            if (m == OverCreditToken.Mode.BonusOnPush) {
                return (false, abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, amount, amount + bonus));
            }
            if (m == OverCreditToken.Mode.UnderDebitOnPush) {
                uint256 stray = ghost.donated(address(overCredit));
                return (false, abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, stray, stray + bonus));
            }
            return (true, "");
        }
        if (m == OverCreditToken.Mode.BonusOnPull) {
            return (false, abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, amount, amount + bonus));
        }
        return (true, "");
    }

    /// @dev Forward-fee token (PayLink exempt as a recipient), deterministic from the mode and the stray balance:
    ///      - `DeductFromAmount`: every path credits the payee `amount - fee` -> `PayeeShortPaid` (on the EIP-3009
    ///        path that is `_pushExact`, the forward leg);
    ///      - `ChargeSender`, EIP-3009: PayLink receives `amount`, forwards `amount` and is charged `fee` on top. With
    ///        donations of at least `fee` the forward succeeds and only the conservation post-check stops the payment
    ///        from spending them (`ReceivedMismatch(balanceBefore, balanceBefore - fee)`); with less, the token
    ///        reverts with its own insufficient-balance error;
    ///      - `ChargeSender`, allowance paths: the payee is credited exactly `amount` and the payer pays the fee to
    ///        the token: PayLink's guarantees hold, so the payment settles.
    function _predictForwardFee(Path path, uint128 amount) internal view returns (bool ok, bytes memory err) {
        uint256 feeAmount = _feeOf(amount);
        if (!_chargesSender()) {
            return (false, abi.encodeWithSelector(IPayLinkV2.PayeeShortPaid.selector, amount, amount - feeAmount));
        }
        if (path != Path.Authorization) return (true, "");
        uint256 stray = ghost.donated(address(fwdFee));
        if (stray < feeAmount) {
            return (
                false,
                abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientBalance.selector, address(payLink), stray, feeAmount
                )
            );
        }
        return (false, abi.encodeWithSelector(IPayLinkV2.ReceivedMismatch.selector, stray, stray - feeAmount));
    }

    function _chargesSender() internal view returns (bool) {
        return fwdFee.mode() == FeeOnTransfer.FeeMode.ChargeSender;
    }

    /// @dev FeeOnTransfer's fee, rounded up.
    function _feeOf(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS + 9999) / 10_000;
    }

    function _isTokenSide(bytes memory err) internal pure returns (bool) {
        if (err.length < 4) return false;
        bytes4 sel = bytes4(err);
        return sel == IPayLinkV2.ReceivedMismatch.selector || sel == IPayLinkV2.PayeeShortPaid.selector
            || sel == IERC20Errors.ERC20InsufficientBalance.selector;
    }

    // ================================================================== bookkeeping

    function _compare(string memory label, bool expectOk, bytes memory expected, bool ok, bytes memory ret) internal {
        ghost.countOutcome(string.concat(label, " -> ", ok ? "ok" : _errorName(ret)));
        if (ok == expectOk && (ok || keccak256(ret) == keccak256(expected))) return;
        _violation(
            0,
            string.concat(
                label,
                ": model expected ",
                expectOk ? "success" : vm.toString(expected),
                ", contract ",
                ok ? "succeeded" : string.concat("reverted ", vm.toString(ret))
            )
        );
    }

    /// @dev Decodes PayLink's logs into the ghost ledger and checks I2-I7 per event; returns the number of `Paid`
    ///      events and the last one. `vm.getRecordedLogs` also
    ///      returns logs emitted inside frames that later reverted: PayLink emits `Paid` before its interactions, so a
    ///      payment the token rejects still leaves a `Paid` in the buffer. Those logs never happened on chain, so the
    ///      buffer is drained and ignored when the call failed (no handler scenario has a reverted PayLink frame
    ///      inside a successful call).
    function _processLogs(string memory label, bool ok) internal returns (uint256 paidCount, PaidLog memory last) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) return (0, last);
        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == address(alt)) {
                _violation(7, string.concat(label, ": the alternate deployment emitted an event"));
                continue;
            }
            if (log.emitter != address(payLink)) continue;
            if (log.topics[0] == IPayLinkV2.InvoiceCancelled.selector) {
                ghost.recordCancelEvent(log.topics[1]);
                continue;
            }
            if (log.topics[0] != IPayLinkV2.Paid.selector) {
                _violation(0, string.concat(label, ": unexpected event"));
                continue;
            }
            ++paidCount;
            last = _decodePaid(log);
            _recordPaid(label, last);
        }
    }

    function _decodePaid(Vm.Log memory log) internal pure returns (PaidLog memory p) {
        p.key = log.topics[1];
        p.payee = address(uint160(uint256(log.topics[2])));
        p.payer = address(uint160(uint256(log.topics[3])));
        (p.token, p.amount, p.index, p.payerRef) = abi.decode(log.data, (address, uint128, uint32, bytes32));
    }

    /// @dev Records one `Paid` in the ghost ledger and checks it against the signed invoice (I2-I7).
    function _recordPaid(string memory label, PaidLog memory p) internal {
        uint256 entryIndex = ghost.entryIndexOf(p.key);
        if (entryIndex == 0) {
            return _violation(7, string.concat(label, ": Paid for a key no invoice of this domain produces"));
        }
        IPayLinkV2.Invoice memory inv = ghost.invoiceAt(entryIndex - 1);
        if (p.index != ghost.paidEvents(p.key)) _violation(3, string.concat(label, ": Paid.index not sequential"));
        ghost.recordPaid(p.key, p.amount);
        if (inv.maxPayments != 0 && ghost.paidEvents(p.key) > inv.maxPayments) {
            _violation(2, string.concat(label, ": more Paid events than maxPayments"));
        }
        if (ghost.cancelEventSeen(p.key)) _violation(4, string.concat(label, ": Paid after InvoiceCancelled"));
        uint256 nowTs = vm.getBlockTimestamp();
        if (nowTs < inv.validAfter || (inv.validUntil != 0 && nowTs > inv.validUntil)) {
            _violation(5, string.concat(label, ": Paid outside [validAfter, validUntil]"));
        }
        if (p.payee != inv.payee || p.token != inv.token) {
            _violation(6, string.concat(label, ": Paid to another payee or token than signed"));
        }
    }

    /// @dev I1 for the call just made, then I11 and model agreement for every key.
    function _afterAction(string memory label, uint256[N_BALANCES] memory before) internal {
        uint256[N_BALANCES] memory afterwards = _balances();
        for (uint256 i = 0; i < N_BALANCES; ++i) {
            // An equality, checked both ways: a balance that grew is as much a violation as one that fell.
            if (afterwards[i] != before[i]) {
                _violation(
                    1,
                    string.concat(
                        label,
                        afterwards[i] > before[i]
                            ? ": PayLink balance grew across the call (balance "
                            : ": PayLink balance fell across the call (balance ",
                        vm.toString(i),
                        ")"
                    )
                );
            }
        }
        uint256 n = ghost.entryCount();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 key = ghost.keyAt(i);
            IPayLinkV2.LinkState memory st = payLink.stateOf(key);
            IPayLinkV2.LinkState memory last = ghost.lastSeen(key);
            if (
                st.payments < last.payments || st.total < last.total || st.lastPaidAt < last.lastPaidAt
                    || (last.cancelled && !st.cancelled)
            ) _violation(11, string.concat(label, ": state went backwards"));
            ghost.setLastSeen(key, st);

            GhostLedger.Model memory m = ghost.model(key);
            if (
                st.payments != m.payments || st.total != m.total || st.cancelled != m.cancelled
                    || st.lastPaidAt != m.lastPaidAt
            ) _violation(0, string.concat(label, ": on-chain state differs from the model"));
        }
    }

    /// @dev Name of a revert reason, for the campaign statistics.
    function _errorName(bytes memory ret) internal pure returns (string memory) {
        if (ret.length < 4) return "revert (no data)";
        bytes4 sel = bytes4(ret);
        if (sel == IPayLinkV2.InvalidInvoice.selector) return "InvalidInvoice";
        if (sel == IPayLinkV2.InvalidSignature.selector) return "InvalidSignature";
        if (sel == IPayLinkV2.SignatureExpired.selector) return "SignatureExpired";
        if (sel == IPayLinkV2.NotPayee.selector) return "NotPayee";
        if (sel == IPayLinkV2.Cancelled.selector) return "Cancelled";
        if (sel == IPayLinkV2.NotYetValid.selector) return "NotYetValid";
        if (sel == IPayLinkV2.Expired.selector) return "Expired";
        if (sel == IPayLinkV2.SoldOut.selector) return "SoldOut";
        if (sel == IPayLinkV2.WrongAmount.selector) return "WrongAmount";
        if (sel == IPayLinkV2.WrongPaymentPath.selector) return "WrongPaymentPath";
        if (sel == IPayLinkV2.SelfPayment.selector) return "SelfPayment";
        if (sel == IPayLinkV2.ReceivedMismatch.selector) return "ReceivedMismatch";
        if (sel == IPayLinkV2.PayeeShortPaid.selector) return "PayeeShortPaid";
        if (sel == IERC20Errors.ERC20InsufficientBalance.selector) return "ERC20InsufficientBalance from the token";
        if (sel == bytes4(keccak256("Error(string)"))) return "Error(string) from the token";
        return "other";
    }

    function _markCancelled(bytes32 key) internal {
        GhostLedger.Model memory m = ghost.model(key);
        m.cancelled = true;
        ghost.setModel(key, m);
    }

    function _violation(uint8 id, string memory reason) internal {
        ghost.recordViolation(id, reason);
    }

    // ================================================================== helpers

    function _create(
        uint256 payeeActor,
        GhostLedger.Asset asset,
        uint256 amountSeed,
        uint256 windowSeed,
        uint256 maxSeed,
        uint256 variety
    ) internal {
        uint256 nowTs = vm.getBlockTimestamp();
        IPayLinkV2.Invoice memory inv;
        inv.payee = payeeActor == WALLET_PAYEE ? address(wallet) : actors[payeeActor];
        inv.token = _tokenOf(asset);
        if (variety == 0) {
            // Seed invoice: open amount, unlimited, valid for 30 days from now.
            inv.validAfter = uint64(nowTs);
            inv.validUntil = uint64(nowTs + 30 days);
        } else {
            inv.amount = amountSeed % 3 == 0 ? 0 : uint128(_bound(amountSeed, 1, _maxAmount(asset)));
            // validAfter in [now - 1 day, now + 6 hours]; validUntil 0 (one in four) or validAfter + [0, 3 days].
            inv.validAfter = uint64(nowTs - 1 days + (windowSeed % 30 hours));
            inv.validUntil =
                _mix(windowSeed, "open") % 4 == 0 ? 0 : uint64(inv.validAfter + _mix(windowSeed, "len") % 3 days);
            inv.maxPayments = uint32(maxSeed % 5);
        }
        inv.salt = keccak256(abi.encode("invoice", ++_nonce));
        inv.memoHash = keccak256(abi.encode("memo", _nonce));

        bytes32 key = _keyOf(inv, address(payLink));
        if (payLink.invoiceKey(inv) != key) {
            _violation(7, "createInvoice: invoiceKey differs from the EIP-712 reference");
        }
        uint256 signer = payeeActor == WALLET_PAYEE ? 0 : payeeActor;
        ghost.addEntry(
            GhostLedger.Entry({
                inv: inv, sig: _sign(_keys[signer], key), key: key, asset: asset, payeeActor: payeeActor
            })
        );
    }

    /// @dev Picks an entry for `path`. Six times in ten a *live* entry whose asset fits the path (not cancelled,
    ///      inside its window, not sold out), so most attempts get past PayLink's checks and settle or reach the
    ///      token; two in ten any fitting entry; two in ten any entry at all, which exercises WrongPaymentPath
    ///      through the regular payment actions. Sub-seeds are hashed, so small fuzz values do not skew the mix.
    function _pick(uint256 seed, Path path) internal view returns (bool found, uint256 idx) {
        uint256 n = ghost.entryCount();
        if (n == 0) return (false, 0);
        idx = seed % n;
        uint256 r = _mix(seed, "pick") % 10;
        if (r < 2) return (true, idx);
        if (r >= 4) {
            for (uint256 j = 0; j < n; ++j) {
                uint256 k = (idx + j) % n;
                GhostLedger.Entry memory e = ghost.entry(k);
                if (_fits(e.asset, path) && _isLive(e)) return (true, k);
            }
        }
        for (uint256 j = 0; j < n; ++j) {
            uint256 k = (idx + j) % n;
            if (_fits(ghost.entry(k).asset, path)) return (true, k);
        }
        return (true, idx);
    }

    function _fits(GhostLedger.Asset asset, Path path) internal pure returns (bool) {
        if (path == Path.Native) return asset == GhostLedger.Asset.Native;
        if (path == Path.Authorization) {
            return asset == GhostLedger.Asset.Usdc3009 || asset == GhostLedger.Asset.FeeToken
                || asset == GhostLedger.Asset.ForwardFee || asset == GhostLedger.Asset.OverCredit;
        }
        return asset != GhostLedger.Asset.Native;
    }

    /// @dev Payable now according to the model: not cancelled, inside its window, not sold out.
    function _isLive(GhostLedger.Entry memory e) internal view returns (bool) {
        GhostLedger.Model memory m = ghost.model(e.key);
        uint256 nowTs = vm.getBlockTimestamp();
        return !m.cancelled && nowTs >= e.inv.validAfter && (e.inv.validUntil == 0 || nowTs <= e.inv.validUntil)
            && (e.inv.maxPayments == 0 || m.payments < e.inv.maxPayments);
    }

    /// @dev Transaction origin for a call whose direct caller is `sender`: the sender itself one time in three (the
    ///      common case), the invoice's payee one time in three (its wallet's owner for the wallet payee: an origin
    ///      is an EOA), otherwise the relayer or another actor. Nothing PayLink checks may depend on it.
    function _originFor(GhostLedger.Entry memory e, uint256 seed, address sender) internal view returns (address) {
        uint256 r = _mix(seed, "origin") % 6;
        if (r < 2) return sender;
        if (r < 4) return e.payeeActor == WALLET_PAYEE ? actors[0] : e.inv.payee;
        if (r == 4) return relayer;
        return actors[_mix(seed, "origin-actor") % N_ACTORS];
    }

    /// @dev Payer actor for an entry: another actor than the payee, except one time in eight when the seed lands on
    ///      the payee itself (SelfPayment).
    function _payerFor(GhostLedger.Entry memory e, uint256 seed) internal view returns (uint256 p) {
        p = seed % N_ACTORS;
        if (actors[p] == e.inv.payee && _mix(seed, "self") % 8 != 0) p = (p + 1) % N_ACTORS;
    }

    /// @dev Independent sub-seed: fuzzers favour small and boundary values, so bit shifts of one seed are correlated.
    function _mix(uint256 seed, string memory tag) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, tag)));
    }

    function _otherEntryOfAsset(uint256 idx, GhostLedger.Asset asset, uint256 seed) internal view returns (uint256) {
        uint256 n = ghost.entryCount();
        for (uint256 j = 1; j < n; ++j) {
            uint256 k = (idx + j + seed) % n;
            if (k != idx && ghost.entry(k).asset == asset) return k;
        }
        return idx;
    }

    /// @dev Mostly the right amount; one in eight is off by one (fixed) or zero (open).
    function _amountFor(GhostLedger.Entry memory e, uint256 seed) internal pure returns (uint128) {
        if (e.inv.amount != 0) {
            if (seed % 8 != 0) return e.inv.amount;
            return seed % 16 == 0 ? e.inv.amount + 1 : e.inv.amount - 1;
        }
        if (seed % 16 == 0) return 0;
        return uint128(_bound(_mix(seed, "amount"), 1, _maxAmount(e.asset)));
    }

    function _maxAmount(GhostLedger.Asset asset) internal pure returns (uint256) {
        if (
            asset == GhostLedger.Asset.Usdc3009 || asset == GhostLedger.Asset.FeeToken
                || asset == GhostLedger.Asset.OverCredit
        ) return 1e12; // 1M at 6 dec
        // 100 at 6 decimals: the 1% fee (<= 1e6) stays within reach of the stray balance, so ChargeSender attempts
        // split between the conservation post-check and the token's insufficient-balance error.
        if (asset == GhostLedger.Asset.ForwardFee) return 1e8;
        return 1e24; // 1M at 18 decimals
    }

    function _tokenOf(GhostLedger.Asset asset) internal view returns (address) {
        if (asset == GhostLedger.Asset.Usdc3009) return address(usdc);
        if (asset == GhostLedger.Asset.MusdPermit) return address(musd);
        if (asset == GhostLedger.Asset.FeeToken) return address(fee);
        if (asset == GhostLedger.Asset.ForwardFee) return address(fwdFee);
        if (asset == GhostLedger.Asset.OverCredit) return address(overCredit);
        return address(0);
    }

    function _balanceOf(GhostLedger.Asset asset, address account) internal view returns (uint256) {
        if (asset == GhostLedger.Asset.Native) return account.balance;
        return MockPermit(_tokenOf(asset)).balanceOf(account);
    }

    /// @dev PayLink's and the alternate deployment's balances: usdc, musd, fee, native (main), then the alternate's
    ///      tokens and native, then fwdFee and overCredit (main). All must stay constant on every non-donation call.
    function _balances() internal view returns (uint256[N_BALANCES] memory b) {
        b[0] = usdc.balanceOf(address(payLink));
        b[1] = musd.balanceOf(address(payLink));
        b[2] = fee.balanceOf(address(payLink));
        b[3] = address(payLink).balance;
        b[4] = usdc.balanceOf(address(alt)) + musd.balanceOf(address(alt)) + fee.balanceOf(address(alt))
            + fwdFee.balanceOf(address(alt)) + overCredit.balanceOf(address(alt));
        b[5] = address(alt).balance;
        b[6] = fwdFee.balanceOf(address(payLink));
        b[7] = overCredit.balanceOf(address(payLink));
    }

    function _assetName(GhostLedger.Asset asset) internal pure returns (string memory) {
        if (asset == GhostLedger.Asset.Usdc3009) return "usdc";
        if (asset == GhostLedger.Asset.MusdPermit) return "musd";
        if (asset == GhostLedger.Asset.FeeToken) return "fee";
        if (asset == GhostLedger.Asset.ForwardFee) return "fwdFee";
        if (asset == GhostLedger.Asset.OverCredit) return "overCredit";
        return "native";
    }

    function _pathName(Path path) internal pure returns (string memory) {
        if (path == Path.Authorization) return "payWithAuthorization";
        if (path == Path.Allowance) return "pay";
        if (path == Path.Permit) return "payWithPermit";
        return "payNative";
    }

    // ------------------------------------------------------------------ signing

    function _sign(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Reference EIP-712 link id, independent of PayLink's own `invoiceKey`.
    function _keyOf(IPayLinkV2.Invoice memory inv, address verifyingContract) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INVOICE_TYPEHASH,
                inv.payee,
                inv.token,
                inv.amount,
                inv.validAfter,
                inv.validUntil,
                inv.maxPayments,
                inv.salt,
                inv.memoHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domain(verifyingContract), structHash));
    }

    /// @dev Reference bound nonce, independent of PayLink's own `paymentNonce`.
    function _boundNonce(bytes32 key, address payerAddr, uint128 amount, bytes32 payerRef, bytes32 payerSalt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payerAddr, amount, payerRef, payerSalt));
    }

    function _domain(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("PayLink"), keccak256("2"), vm.getChainId(), verifyingContract)
        );
    }

    function _liveCount() internal view returns (uint256 live) {
        uint256 n = ghost.entryCount();
        for (uint256 i = 0; i < n; ++i) {
            if (_isLive(ghost.entry(i))) ++live;
        }
    }

    function _cancelDigest(address verifyingContract, bytes32 key, uint256 deadline) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", _domain(verifyingContract), keccak256(abi.encode(CANCEL_TYPEHASH, key, deadline))
            )
        );
    }

    function _authorize(
        uint256 payerIdx,
        address token,
        address to,
        bytes32 key,
        uint128 amount,
        bytes32 payerRef,
        bytes32 payerSalt
    ) internal view returns (IPayLinkV2.Authorization memory auth) {
        auth.payer = actors[payerIdx];
        auth.amount = amount;
        auth.payerRef = payerRef;
        auth.payerSalt = payerSalt;
        auth.validAfter = vm.getBlockTimestamp() - 1;
        auth.validBefore = vm.getBlockTimestamp() + 1 hours;
        bytes32 nonce = _boundNonce(key, auth.payer, amount, payerRef, payerSalt);
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                auth.payer,
                to,
                uint256(amount),
                auth.validAfter,
                auth.validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", MockPermit(token).DOMAIN_SEPARATOR(), structHash));
        (auth.v, auth.r, auth.s) = vm.sign(_keys[payerIdx], digest);
    }

    function _permit(uint256 ownerIdx, address token, uint256 value)
        internal
        view
        returns (IPayLinkV2.Permit memory p)
    {
        address owner = actors[ownerIdx];
        p.deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, address(payLink), value, MockPermit(token).nonces(owner), p.deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", MockPermit(token).DOMAIN_SEPARATOR(), structHash));
        (p.v, p.r, p.s) = vm.sign(_keys[ownerIdx], digest);
    }
}
