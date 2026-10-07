// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PayLinkV2} from "../../src/PayLinkV2.sol";
import {IPayLinkV2} from "../../src/interfaces/IPayLinkV2.sol";
import {PropertyActor, PropertyToken} from "./PropertyMocks.sol";

/// @title PayLinkProperties: invariants I1-I11 for Echidna and Medusa (one property contract for both)
/// @notice PAYLINK-V2-SPEC §4.1 runs Echidna and Medusa against the same property contract. Neither fuzzer offers
///         Foundry's log recording, two-argument prank or signing cheatcodes in a common form, so this harness uses
///         no cheatcode at all (the Foundry campaign in test/invariant/ keeps its richer model):
///         - three `PropertyActor` contracts are the payers and payees; payee signatures are ERC-1271 approvals of
///           the exact link id (and of the exact `Cancel` digest for `cancelBySig`), so PayLinkV2's signature
///           check runs for real; the link id, the cancel digest and the EIP-3009 nonce are recomputed here from
///           the EIP-712 definitions, independently of PayLinkV2;
///         - two `PropertyToken`s: `stdToken` stays standard, `skewToken` has legs the fuzzer reconfigures, one side
///           at a time, to move more or less than asked (fee, charge-the-sender, over-credit, rebate); EIP-3009 authorizations are the
///           payer's on-chain approval of the exact tuple, so a tampered relay must fail (I8);
///         - native coin, held by the actors when the deployment funds this contract (`balanceContract` in
///           echidna.yaml, `targetContractsBalances` in medusa.json);
///         - an alternate PayLinkV2 deployment for replays (I7).
///         Every action checks its per-call properties and records violations by invariant ID; each `echidna_*`
///         function (also Medusa's property prefix) returns false once its invariant was violated or its state check
///         fails. Fuzzer-chosen block times move invoices in and out of their windows.
/// @dev Echidna 2.2.7 and Medusa 1.3.1, configs and commands in this folder's echidna.yaml and medusa.json and in
///      protocol/audit/properties.md. `PayLinkProperties.t.sol` deploys it on every `forge test` and checks that every
///      payment path can settle and every refusal the properties rely on happens, so the harness cannot rot silently.
contract PayLinkProperties {
    uint256 internal constant N_ACTORS = 3;
    uint256 internal constant MAX_INVOICES = 24;
    uint8 internal constant STD = 0;
    uint8 internal constant SKEW = 1;
    uint8 internal constant NATIVE = 2;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant INVOICE_TYPEHASH = keccak256(
        "Invoice(address payee,address token,uint128 amount,uint64 validAfter,uint64 validUntil,uint32 maxPayments,bytes32 salt,bytes32 memoHash)"
    );
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 key,uint256 deadline)");
    bytes32 internal constant PAYMENT_BINDING_TYPEHASH =
        keccak256("PayLinkPayment(bytes32 key,address payer,uint128 amount,bytes32 payerRef,bytes32 payerSalt)");

    enum Path {
        Authorization,
        Allowance,
        Permit,
        Native
    }

    struct Entry {
        IPayLinkV2.Invoice inv;
        bytes32 key;
        uint8 asset;
        uint8 payeeIdx;
    }

    /// @dev Balances around one payment attempt.
    struct Snapshot {
        uint256[3] payLink;
        uint256 payee;
        uint256 payer;
    }

    PayLinkV2 public immutable payLink;
    PayLinkV2 public immutable alt;
    PropertyToken public immutable stdToken;
    PropertyToken public immutable skewToken;
    PropertyActor[N_ACTORS] public actors;

    Entry[] internal _entries;
    mapping(bytes32 key => uint256) public paidCount;
    mapping(bytes32 key => uint256) public paidSum;
    mapping(bytes32 key => bool) public cancelledSeen;
    mapping(bytes32 key => IPayLinkV2.LinkState) internal _lastSeen;
    uint256[3] public donated;
    /// @notice Violations by invariant ID (index 1..11); index 0 is a documented check outside I1-I11 (SelfPayment).
    uint256[12] public violations;
    /// @notice Payments that settled, for the record (a campaign that settles nothing proves nothing).
    uint256 public settled;
    uint256 internal _nonce;

    constructor() payable {
        payLink = new PayLinkV2();
        alt = new PayLinkV2();
        stdToken = new PropertyToken(address(payLink));
        skewToken = new PropertyToken(address(payLink));
        for (uint256 i = 0; i < N_ACTORS; ++i) {
            actors[i] = new PropertyActor();
            if (msg.value != 0) {
                (bool ok,) = address(actors[i]).call{value: msg.value / N_ACTORS}("");
                require(ok, "fund actor");
            }
        }
        for (uint8 a = 0; a < 3; ++a) {
            _create(a % N_ACTORS, a, 0, 0, 0); // one open, unlimited, 30-day invoice per asset
        }
    }

    // ================================================================== actions

    function createInvoice(uint8 payeeSeed, uint8 assetSeed, uint128 amountSeed, uint32 windowSeed, uint8 maxSeed)
        public
    {
        if (_entries.length >= MAX_INVOICES) return;
        _create(payeeSeed % N_ACTORS, uint8(assetSeed % 3), amountSeed, windowSeed, maxSeed);
    }

    /// @notice Relayed EIP-3009 payment; `tamper` != 0 changes one field of the authorized tuple (I8).
    function payWithAuthorization(uint8 invSeed, uint8 payerSeed, uint128 amountSeed, uint8 tamper) public {
        Entry memory e = _entries[invSeed % _entries.length];
        PropertyActor payer = actors[payerSeed % N_ACTORS];
        uint128 amount = _amountFor(e, amountSeed);
        address token = e.asset == NATIVE ? address(stdToken) : e.inv.token;
        PropertyToken(token).mint(address(payer), uint256(amount) + 1);

        IPayLinkV2.Authorization memory auth;
        auth.payer = address(payer);
        auth.amount = amount;
        auth.payerRef = keccak256(abi.encode("ref", ++_nonce));
        auth.payerSalt = keccak256(abi.encode("salt", _nonce));
        auth.validAfter = block.timestamp == 0 ? 0 : block.timestamp - 1;
        auth.validBefore = block.timestamp + 1 hours;
        bytes32 nonce = _boundNonce(e.key, address(payer), amount, auth.payerRef, auth.payerSalt);
        payer.execute(
            token,
            0,
            abi.encodeCall(
                PropertyToken.approveAuthorization, (address(payLink), amount, auth.validAfter, auth.validBefore, nonce)
            )
        );
        uint256 field = tamper % 4;
        if (field == 1) auth.amount = amount + 1;
        else if (field == 2) auth.payerRef = bytes32(uint256(auth.payerRef) ^ 1);
        else if (field == 3) auth.payerSalt = bytes32(uint256(auth.payerSalt) ^ 1);

        Snapshot memory s = _snapshot(e, address(payer));
        (bool ok, bytes memory ret) =
            address(payLink).call(abi.encodeCall(PayLinkV2.payWithAuthorization, (e.inv, "", auth)));
        if (ok && field != 0) _violation(8);
        _afterPayment(e, s, address(payer), Path.Authorization, ok, ret, auth.amount);
    }

    function pay(uint8 invSeed, uint8 payerSeed, uint128 amountSeed) public {
        _payFromActor(invSeed, payerSeed, amountSeed, Path.Allowance);
    }

    function payWithPermit(uint8 invSeed, uint8 payerSeed, uint128 amountSeed) public {
        _payFromActor(invSeed, payerSeed, amountSeed, Path.Permit);
    }

    function payNative(uint8 invSeed, uint8 payerSeed, uint128 amountSeed) public {
        _payFromActor(invSeed, payerSeed, amountSeed, Path.Native);
    }

    /// @notice I9: any actor tries to cancel; only the payee may succeed.
    function cancel(uint8 invSeed, uint8 callerSeed) public {
        Entry memory e = _entries[invSeed % _entries.length];
        uint256 caller = callerSeed % N_ACTORS;
        uint256[3] memory before = _payLinkBalances();
        (bool ok,) = actors[caller].execute(address(payLink), 0, abi.encodeCall(PayLinkV2.cancel, (e.inv)));
        if (ok) {
            if (caller != e.payeeIdx || cancelledSeen[e.key]) _violation(9);
            cancelledSeen[e.key] = true;
        }
        _afterCall(before);
    }

    /// @notice I9: a relayed cancellation approved by any actor (the payee or not), with a deadline that may have
    ///         passed.
    function cancelBySig(uint8 invSeed, uint8 signerSeed, uint32 deadlineSeed) public {
        Entry memory e = _entries[invSeed % _entries.length];
        uint256 signer = signerSeed % N_ACTORS;
        // A quarter of them already expired.
        uint256 deadline =
            block.timestamp + (deadlineSeed % 2 days) - (block.timestamp < 12 hours ? block.timestamp : 12 hours);
        actors[signer].approve(_cancelDigest(address(payLink), e.key, deadline));
        uint256[3] memory before = _payLinkBalances();
        (bool ok,) = address(payLink).call(abi.encodeCall(PayLinkV2.cancelBySig, (e.inv, deadline, "")));
        if (ok) {
            if (signer != e.payeeIdx || block.timestamp > deadline || cancelledSeen[e.key]) _violation(9);
            cancelledSeen[e.key] = true;
        }
        _afterCall(before);
    }

    /// @notice I7: the payee's approvals are for this deployment's digests; the alternate deployment must refuse
    ///         both a payment and a cancellation the payee approved here.
    function replayOnAlternate(uint8 invSeed, uint8 payerSeed, bool cancelReplay) public {
        Entry memory e = _entries[invSeed % _entries.length];
        uint256[3] memory before = _payLinkBalances();
        bool ok;
        if (cancelReplay) {
            uint256 deadline = block.timestamp + 1 days;
            actors[e.payeeIdx].approve(_cancelDigest(address(payLink), e.key, deadline));
            (ok,) = address(alt).call(abi.encodeCall(PayLinkV2.cancelBySig, (e.inv, deadline, "")));
        } else {
            PropertyActor payer = actors[payerSeed % N_ACTORS];
            uint128 amount = e.inv.amount != 0 ? e.inv.amount : 1;
            if (e.asset == NATIVE) {
                if (address(payer).balance < amount) return;
                (ok,) = payer.execute(address(alt), amount, abi.encodeCall(PayLinkV2.payNative, (e.inv, "", "")));
            } else {
                PropertyToken(e.inv.token).mint(address(payer), amount);
                payer.execute(e.inv.token, 0, abi.encodeCall(PropertyToken.approve, (address(alt), amount)));
                (ok,) = payer.execute(address(alt), 0, abi.encodeCall(PayLinkV2.pay, (e.inv, "", amount, "")));
            }
        }
        if (ok) _violation(7);
        _afterCall(before);
    }

    /// @notice I10: plain native transfers and unknown selectors are refused.
    function sendToPayLink(uint8 actorSeed, bool unknownSelector) public {
        PropertyActor a = actors[actorSeed % N_ACTORS];
        if (address(a).balance == 0) return;
        uint256[3] memory before = _payLinkBalances();
        (bool ok,) = a.execute(address(payLink), 1, unknownSelector ? abi.encodeWithSignature("sweep()") : bytes(""));
        if (ok) _violation(10);
        _afterCall(before);
    }

    /// @notice Stray token transfers (donations) to PayLink; they must stay inert.
    function donate(bool skewed, uint128 amount) public {
        (skewed ? skewToken : stdToken).mint(address(payLink), amount);
        donated[skewed ? SKEW : STD] += amount;
    }

    /// @notice Reconfigures one side (the credit to the recipient, or the debit from the sender) of one leg of
    ///         `skewToken` (receive, forward or pull) to move up to 1e6 base units more or less than asked, or resets
    ///         every leg. One side at a time, so that each exactness check can be reached alone (a forward leg that
    ///         debits PayLink less but credits the payee exactly is what only the conservation post-check sees).
    function reconfigureSkew(uint8 legSeed, bool debitSide, uint32 delta, bool up) public {
        uint8 leg = legSeed % 4;
        if (leg == 3) {
            skewToken.resetSkews();
        } else if (debitSide) {
            skewToken.skewDebit(leg, 1 + delta % 1e6, up);
        } else {
            skewToken.skewCredit(leg, 1 + delta % 1e6, up);
        }
    }

    // ================================================================== views (not fuzzed by Medusa: testViewMethods is off)

    function entryCount() external view returns (uint256) {
        return _entries.length;
    }

    function entry(uint256 i)
        external
        view
        returns (IPayLinkV2.Invoice memory inv, bytes32 key, uint8 asset, uint8 payee)
    {
        Entry storage e = _entries[i];
        return (e.inv, e.key, e.asset, e.payeeIdx);
    }

    // ================================================================== properties

    /// @notice I1: PayLink holds exactly what was donated, per token and in native; the alternate holds nothing.
    function echidna_I1_conservation() public view returns (bool) {
        return violations[1] == 0 && stdToken.balanceOf(address(payLink)) == donated[STD]
            && skewToken.balanceOf(address(payLink)) == donated[SKEW] && address(payLink).balance == donated[NATIVE]
            && stdToken.balanceOf(address(alt)) + skewToken.balanceOf(address(alt)) + address(alt).balance == 0;
    }

    /// @notice I2: `payments <= maxPayments` whenever `maxPayments > 0`.
    function echidna_I2_paymentsNeverExceedMax() public view returns (bool) {
        for (uint256 i = 0; i < _entries.length; ++i) {
            IPayLinkV2.Invoice memory inv = _entries[i].inv;
            if (inv.maxPayments != 0 && payLink.stateOf(_entries[i].key).payments > inv.maxPayments) return false;
        }
        return violations[2] == 0;
    }

    /// @notice I3: `total` and `payments` equal the sum and number of the payments PayLink accepted.
    function echidna_I3_totalsMatchPayments() public view returns (bool) {
        for (uint256 i = 0; i < _entries.length; ++i) {
            bytes32 key = _entries[i].key;
            IPayLinkV2.LinkState memory st = payLink.stateOf(key);
            if (st.total != paidSum[key] || st.payments != paidCount[key]) return false;
        }
        return violations[3] == 0;
    }

    /// @notice I4: a cancelled key never settles again, and the flag matches the cancellations that succeeded.
    function echidna_I4_noPaymentAfterCancel() public view returns (bool) {
        for (uint256 i = 0; i < _entries.length; ++i) {
            if (payLink.stateOf(_entries[i].key).cancelled != cancelledSeen[_entries[i].key]) return false;
        }
        return violations[4] == 0;
    }

    /// @notice I5: no payment outside `[validAfter, validUntil]`.
    function echidna_I5_paymentsInsideWindow() public view returns (bool) {
        for (uint256 i = 0; i < _entries.length; ++i) {
            IPayLinkV2.Invoice memory inv = _entries[i].inv;
            uint64 lastPaidAt = payLink.stateOf(_entries[i].key).lastPaidAt;
            if (lastPaidAt == 0) continue;
            if (lastPaidAt < inv.validAfter || (inv.validUntil != 0 && lastPaidAt > inv.validUntil)) return false;
        }
        return violations[5] == 0;
    }

    /// @notice I6: each payment credited the payee exactly `amount` (payer debited exactly `amount` on the standard
    ///         token and in native); fixed invoices settle exactly `inv.amount`.
    function echidna_I6_exactness() public view returns (bool) {
        for (uint256 i = 0; i < _entries.length; ++i) {
            Entry memory e = _entries[i];
            IPayLinkV2.LinkState memory st = payLink.stateOf(e.key);
            if (e.inv.amount != 0 && st.total != uint256(e.inv.amount) * st.payments) return false;
        }
        return violations[6] == 0;
    }

    /// @notice I7: approvals for this deployment never settle or cancel anything on the alternate one.
    function echidna_I7_domainSeparation() public view returns (bool) {
        for (uint256 i = 0; i < _entries.length; ++i) {
            IPayLinkV2.LinkState memory st = alt.stateOf(alt.invoiceKey(_entries[i].inv));
            if (st.payments != 0 || st.cancelled) return false;
        }
        return violations[7] == 0;
    }

    /// @notice Documented checks outside I1-I11: a payer never pays itself (`SelfPayment`).
    function echidna_documentedChecksHold() public view returns (bool) {
        return violations[0] == 0;
    }

    /// @notice I8: a relay that changed the authorized tuple never settled.
    function echidna_I8_authorizationBinding() public view returns (bool) {
        return violations[8] == 0;
    }

    /// @notice I9: only the payee cancels, by `msg.sender` or by its own approval, before the deadline.
    function echidna_I9_onlyPayeeCancels() public view returns (bool) {
        return violations[9] == 0;
    }

    /// @notice I10: native invoices only through `payNative`, ERC-20 invoices never through it; plain transfers and
    ///         unknown calls refused.
    function echidna_I10_pathSeparation() public view returns (bool) {
        return violations[10] == 0;
    }

    /// @notice I11: `payments`, `total` and `lastPaidAt` never decrease; `cancelled` never resets.
    function echidna_I11_monotonicState() public view returns (bool) {
        return violations[11] == 0;
    }

    // ================================================================== internals

    function _payFromActor(uint8 invSeed, uint8 payerSeed, uint128 amountSeed, Path path) internal {
        Entry memory e = _entries[invSeed % _entries.length];
        PropertyActor payer = actors[payerSeed % N_ACTORS];
        uint128 amount = _amountFor(e, amountSeed);
        bytes memory data;
        uint256 value;
        if (path == Path.Native) {
            if (address(payer).balance < amount) amount = uint128(address(payer).balance);
            value = amount;
            data = abi.encodeCall(PayLinkV2.payNative, (e.inv, "", "native"));
        } else {
            address token = e.asset == NATIVE ? address(stdToken) : e.inv.token;
            PropertyToken(token).mint(address(payer), amount);
            payer.execute(token, 0, abi.encodeCall(PropertyToken.approve, (address(payLink), amount)));
            IPayLinkV2.Permit memory p; // no permit on PropertyToken: the `try` fails, the allowance pays
            data = path == Path.Permit
                ? abi.encodeCall(PayLinkV2.payWithPermit, (e.inv, "", amount, "permit", p))
                : abi.encodeCall(PayLinkV2.pay, (e.inv, "", amount, "pay"));
        }
        Snapshot memory s = _snapshot(e, address(payer));
        (bool ok, bytes memory ret) = payer.execute(address(payLink), value, data);
        _afterPayment(e, s, address(payer), path, ok, ret, amount);
    }

    /// @dev Per-call properties of a payment attempt, then I1 and I11 for the call.
    function _afterPayment(
        Entry memory e,
        Snapshot memory s,
        address payer,
        Path path,
        bool ok,
        bytes memory ret,
        uint128 amount
    ) internal {
        if (ok) {
            uint256 nowTs = block.timestamp;
            if ((e.asset == NATIVE) != (path == Path.Native)) _violation(10);
            if (cancelledSeen[e.key]) _violation(4);
            if (nowTs < e.inv.validAfter || (e.inv.validUntil != 0 && nowTs > e.inv.validUntil)) _violation(5);
            if (e.inv.maxPayments != 0 && paidCount[e.key] >= e.inv.maxPayments) _violation(2);
            if (e.inv.amount != 0 ? amount != e.inv.amount : amount == 0) _violation(6);
            if (payer == e.inv.payee) _violation(0); // SelfPayment
            if (_balanceOf(e.asset, e.inv.payee) != s.payee + amount) _violation(6);
            if (e.asset != SKEW && _balanceOf(e.asset, payer) + amount != s.payer) _violation(6);
            if (abi.decode(ret, (uint32)) != paidCount[e.key]) _violation(3);
            paidCount[e.key] += 1;
            paidSum[e.key] += amount;
            ++settled;
        }
        _afterCall(s.payLink);
    }

    /// @dev I1 for the call just made (PayLink's balances unchanged, in both directions), then I11 for every key.
    function _afterCall(uint256[3] memory before) internal {
        uint256[3] memory afterwards = _payLinkBalances();
        for (uint256 i = 0; i < 3; ++i) {
            if (afterwards[i] != before[i]) _violation(1);
        }
        for (uint256 i = 0; i < _entries.length; ++i) {
            bytes32 key = _entries[i].key;
            IPayLinkV2.LinkState memory st = payLink.stateOf(key);
            IPayLinkV2.LinkState memory last = _lastSeen[key];
            if (
                st.payments < last.payments || st.total < last.total || st.lastPaidAt < last.lastPaidAt
                    || (last.cancelled && !st.cancelled)
            ) _violation(11);
            _lastSeen[key] = st;
        }
    }

    function _create(uint256 payeeIdx, uint8 asset, uint128 amountSeed, uint32 windowSeed, uint8 maxSeed) internal {
        IPayLinkV2.Invoice memory inv;
        inv.payee = address(actors[payeeIdx]);
        inv.token = asset == NATIVE ? address(0) : asset == STD ? address(stdToken) : address(skewToken);
        uint256 nowTs = block.timestamp;
        if (windowSeed == 0) {
            inv.validAfter = uint64(nowTs);
            inv.validUntil = uint64(nowTs + 30 days);
        } else {
            inv.amount = amountSeed % 3 == 0 ? 0 : uint128(1 + amountSeed % 1e12);
            // Started up to a day ago or starting within six hours; open-ended one time in five, else up to 3 days.
            inv.validAfter = uint64((nowTs > 1 days ? nowTs - 1 days : 0) + windowSeed % 30 hours);
            inv.validUntil = windowSeed % 5 == 0 ? 0 : uint64(inv.validAfter + windowSeed % 3 days);
            inv.maxPayments = uint32(maxSeed % 5);
        }
        inv.salt = keccak256(abi.encode("invoice", ++_nonce));
        inv.memoHash = keccak256(abi.encode("memo", _nonce));
        bytes32 key = _keyOf(inv, address(payLink));
        actors[payeeIdx].approve(key); // the payee signs its invoice (ERC-1271)
        _entries.push(Entry({inv: inv, key: key, asset: asset, payeeIdx: uint8(payeeIdx)}));
    }

    /// @dev Mostly the right amount; one time in eight off by one (fixed) or zero (open).
    function _amountFor(Entry memory e, uint128 seed) internal pure returns (uint128) {
        if (e.inv.amount != 0) {
            if (seed % 8 != 0) return e.inv.amount;
            return seed % 16 == 0 ? e.inv.amount + 1 : e.inv.amount - 1;
        }
        if (seed % 16 == 0) return 0;
        return uint128(1 + seed % 1e12);
    }

    function _snapshot(Entry memory e, address payer) internal view returns (Snapshot memory s) {
        s.payLink = _payLinkBalances();
        s.payee = _balanceOf(e.asset, e.inv.payee);
        s.payer = _balanceOf(e.asset, payer);
    }

    function _payLinkBalances() internal view returns (uint256[3] memory b) {
        b[STD] = stdToken.balanceOf(address(payLink));
        b[SKEW] = skewToken.balanceOf(address(payLink));
        b[NATIVE] = address(payLink).balance;
    }

    function _balanceOf(uint8 asset, address account) internal view returns (uint256) {
        if (asset == NATIVE) return account.balance;
        return (asset == STD ? stdToken : skewToken).balanceOf(account);
    }

    function _violation(uint256 id) internal {
        ++violations[id];
    }

    // ------------------------------------------------------------------ EIP-712 reference (independent of PayLink)

    function _domain(address verifyingContract) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(DOMAIN_TYPEHASH, keccak256("PayLink"), keccak256("2"), block.chainid, verifyingContract)
            );
    }

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

    function _cancelDigest(address verifyingContract, bytes32 key, uint256 deadline) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", _domain(verifyingContract), keccak256(abi.encode(CANCEL_TYPEHASH, key, deadline))
            )
        );
    }

    function _boundNonce(bytes32 key, address payer, uint128 amount, bytes32 payerRef, bytes32 payerSalt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payer, amount, payerRef, payerSalt));
    }
}
