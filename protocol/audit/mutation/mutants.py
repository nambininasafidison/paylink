# SPDX-License-Identifier: MIT
"""Hand-written, targeted mutants of protocol/src/PayLinkV2.sol, for protocol/audit/mutation/run.py.

Each mutant is (id, description, old, new): `old` must occur exactly once in the source, and the mutant replaces it
with `new`. M01-M45 change one rule each (dropped checks, off-by-one bounds, swapped check order, unchecked
counters, wrong event fields, missing nonReentrant, weakened permit handling...); P1-P4 reorder the documented
error precedence. Written for the 2026-10-07 pre-freeze audit; see protocol/audit/README.md#mutation-testing.
M46-M49 come from the 2026-10-07 re-audit (its R47-R50): on each settlement path, the link-state write is deferred
past the interaction, so that any code running during the transfer reads the pre-payment state (checks-effects-
interactions broken for read-only re-entry) while checks, events, error precedence and the final state are unchanged.
M50-M59 come from the 2026-10-07 test-quality review (its R01-R05 and R20; the first re-audit's R14-R17 are the same
four one-sided checks): M50-M54 weaken the exactness checks from `!=` to `<`, so that a delta *above* the amount is
accepted (PayLink keeps a surplus, or the payee is over-credited: I1 and I6 broken in the growth direction); M55-M59
let `tx.origin` stand in for `msg.sender` or for a signature (SWC-115), on `cancel`, `cancelBySig` and the payer of
the three paths where the payer is the caller.
"""
import os as _os

_SRC = open(
    _os.environ.get("PAYLINK_SRC", _os.path.join(_os.path.dirname(__file__), "..", "..", "src", "PayLinkV2.sol"))
).read()
_WPP = "        if ((inv.token == address(0)) != native) revert WrongPaymentPath();\n"
_SELF = "        if (payer == inv.payee) revert SelfPayment();\n"
_BLOCK = _SRC[_SRC.index(_WPP):_SRC.index(_SELF) + len(_SELF)]
_SIG = "        if (!SignatureChecker.isValidSignatureNow(inv.payee, key, payeeSig)) revert InvalidSignature();\n"
_EXP = "        if (inv.validUntil != 0 && block.timestamp > inv.validUntil) revert Expired(inv.validUntil);\n"
MUTANTS = [
 ("M01", "drop Cancelled check in _record",
  "        if (st.cancelled) revert Cancelled();\n        if (!SignatureChecker.isValidSignatureNow(inv.payee, key, payeeSig)) revert InvalidSignature();",
  "        if (!SignatureChecker.isValidSignatureNow(inv.payee, key, payeeSig)) revert InvalidSignature();"),
 ("M02", "validAfter off-by-one (< -> <=)",
  "if (block.timestamp < inv.validAfter) revert", "if (block.timestamp <= inv.validAfter) revert"),
 ("M03", "validUntil off-by-one (> -> >=)",
  "inv.validUntil != 0 && block.timestamp > inv.validUntil", "inv.validUntil != 0 && block.timestamp >= inv.validUntil"),
 ("M04", "SoldOut off-by-one (>= -> >)",
  "st.payments >= inv.maxPayments", "st.payments > inv.maxPayments"),
 ("M05", "open amount accepts zero",
  "if (inv.amount == 0 ? amount == 0 : amount != inv.amount)", "if (inv.amount == 0 ? false : amount != inv.amount)"),
 ("M06", "drop SelfPayment check",
  "        if (payer == inv.payee) revert SelfPayment();\n", ""),
 ("M07", "total overwritten instead of accumulated",
  "st.total += amount;", "st.total = amount;"),
 ("M08", "lastPaidAt only set on first payment",
  "st.lastPaidAt = uint64(block.timestamp);", "if (st.lastPaidAt == 0) st.lastPaidAt = uint64(block.timestamp);"),
 ("M09", "payment binding drops payerRef (view and settlement)",
  "keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payer, amount, payerRef, payerSalt))",
  "keccak256(abi.encode(PAYMENT_BINDING_TYPEHASH, key, payer, amount, bytes32(0), payerSalt))"),
 ("M10", "drop ReceivedMismatch (receive-delta) check",
  "        if (received != auth.amount) revert ReceivedMismatch(auth.amount, received);\n", ""),
 ("M11", "drop conservation post-check in 3009 path",
  "        if (balanceAfter != balanceBefore) revert ReceivedMismatch(balanceBefore, balanceAfter);\n", ""),
 ("M12", "drop payee-delta check in _pullExact",
  "        token.safeTransferFrom(from, payee, amount);\n        uint256 credited = _increase(balanceBefore, token.balanceOf(payee));\n        if (credited != amount) revert PayeeShortPaid(amount, credited);",
  "        token.safeTransferFrom(from, payee, amount);\n        uint256 credited = _increase(balanceBefore, token.balanceOf(payee));\n        credited;"),
 ("M13", "drop payee-delta check in _pushExact",
  "        token.safeTransfer(payee, amount);\n        uint256 credited = _increase(balanceBefore, token.balanceOf(payee));\n        if (credited != amount) revert PayeeShortPaid(amount, credited);",
  "        token.safeTransfer(payee, amount);\n        uint256 credited = _increase(balanceBefore, token.balanceOf(payee));\n        credited;"),
 ("M14", "cancel: drop NotPayee",
  "        if (msg.sender != inv.payee) revert NotPayee();\n", ""),
 ("M15", "cancelBySig deadline off-by-one (> -> >=)",
  "if (block.timestamp > deadline) revert SignatureExpired(deadline);", "if (block.timestamp >= deadline) revert SignatureExpired(deadline);"),
 ("M16", "cancelBySig verifies the invoice key instead of the Cancel digest",
  "if (!SignatureChecker.isValidSignatureNow(inv.payee, digest, payeeSig)) revert InvalidSignature();",
  "digest; if (!SignatureChecker.isValidSignatureNow(inv.payee, key, payeeSig)) revert InvalidSignature();"),
 ("M17", "_checkShape: drop token == this",
  "inv.payee == address(this) || inv.token == address(this)", "inv.payee == address(this)"),
 ("M18", "_checkShape: validUntil < validAfter -> <=",
  "if (inv.validUntil != 0 && inv.validUntil < inv.validAfter) revert InvalidInvoice();",
  "if (inv.validUntil != 0 && inv.validUntil <= inv.validAfter) revert InvalidInvoice();"),
 ("M19", "Paid.payer = msg.sender (relayer on 3009 path)",
  "emit Paid(key, inv.payee, payer, inv.token, amount, index, payerRef);",
  "emit Paid(key, inv.payee, msg.sender, inv.token, amount, index, payerRef);"),
 ("M20", "payWithPermit: permit not in try/catch",
  "try IERC20Permit(inv.token).permit(msg.sender, address(this), amount, p.deadline, p.v, p.r, p.s) {} catch {}",
  "IERC20Permit(inv.token).permit(msg.sender, address(this), amount, p.deadline, p.v, p.r, p.s);"),
 ("M21", "payNative: drop uint128 guard",
  "        if (msg.value > type(uint128).max) revert WrongAmount(inv.amount, type(uint128).max);\n", ""),
 ("M22", "statesOf bound off-by-one (> -> >=)",
  "if (n > MAX_BATCH) revert", "if (n >= MAX_BATCH) revert"),
 ("M23", "cancel without nonReentrant",
  "function cancel(Invoice calldata inv) external nonReentrant {", "function cancel(Invoice calldata inv) external {"),
 ("M24", "cancelBySig without nonReentrant",
  "function cancelBySig(Invoice calldata inv, uint256 deadline, bytes calldata payeeSig) external nonReentrant {",
  "function cancelBySig(Invoice calldata inv, uint256 deadline, bytes calldata payeeSig) external {"),
 ("M25", "payNative without nonReentrant",
  "        payable\n        nonReentrant\n        returns (uint32 index)", "        payable\n        returns (uint32 index)"),
 ("M26", "payWithPermit without nonReentrant",
  "    ) external nonReentrant returns (uint32 index) {", "    ) external returns (uint32 index) {"),
 ("M27", "check order: InvalidSignature before Cancelled",
  "        if (st.cancelled) revert Cancelled();\n        if (!SignatureChecker.isValidSignatureNow(inv.payee, key, payeeSig)) revert InvalidSignature();",
  "        if (!SignatureChecker.isValidSignatureNow(inv.payee, key, payeeSig)) revert InvalidSignature();\n        if (st.cancelled) revert Cancelled();"),
 ("M28", "check order: SelfPayment before WrongAmount",
  "        if (inv.amount == 0 ? amount == 0 : amount != inv.amount) revert WrongAmount(inv.amount, amount);\n        if (payer == inv.payee) revert SelfPayment();",
  "        if (payer == inv.payee) revert SelfPayment();\n        if (inv.amount == 0 ? amount == 0 : amount != inv.amount) revert WrongAmount(inv.amount, amount);"),
 ("M29", "_increase: checked subtraction (panics on decrease)",
  "return afterwards > before ? afterwards - before : 0;", "return afterwards - before;"),
 ("M30", "check order: WrongPaymentPath moved after SelfPayment",
  _BLOCK, _BLOCK.replace(_WPP, "").replace(_SELF, _SELF + _WPP)),
 ("M31", "cancelBySig emits msg.sender as payee",
  "        if (!SignatureChecker.isValidSignatureNow(inv.payee, digest, payeeSig)) revert InvalidSignature();\n        _markCancelled(st, key, inv.payee);",
  "        if (!SignatureChecker.isValidSignatureNow(inv.payee, digest, payeeSig)) revert InvalidSignature();\n        _markCancelled(st, key, msg.sender);"),
 ("M32", "payNative uses transfer (2300 stipend) instead of sendValue",
  "Address.sendValue(payable(inv.payee), msg.value);", "payable(inv.payee).transfer(msg.value);"),
 ("M33", "validUntil == 0 treated as expired",
  "inv.validUntil != 0 && block.timestamp > inv.validUntil", "block.timestamp > inv.validUntil"),
 ("M34", "receive() accepts native",
  "    receive() external payable {\n        revert WrongPaymentPath();\n    }", "    receive() external payable {}"),
 ("M35", "cancelBySig: drop already-cancelled check",
  "        LinkState storage st = _states[key];\n        if (st.cancelled) revert Cancelled();\n        bytes32 digest",
  "        LinkState storage st = _states[key];\n        bytes32 digest"),
 ("M36", "payWithPermit: permit for max value",
  "permit(msg.sender, address(this), amount, p.deadline", "permit(msg.sender, address(this), type(uint256).max, p.deadline"),
 ("M37", "statesOf returns first key's state for all",
  "states[i] = _states[keys[i]];", "states[i] = _states[keys[0]];"),
 ("M38", "cancel: drop _checkShape",
  "    function cancel(Invoice calldata inv) external nonReentrant {\n        _checkShape(inv);\n",
  "    function cancel(Invoice calldata inv) external nonReentrant {\n"),
 ("M39", "Paid.amount = inv.amount (wrong for open invoices)",
  "emit Paid(key, inv.payee, payer, inv.token, amount, index, payerRef);",
  "emit Paid(key, inv.payee, payer, inv.token, inv.amount, index, payerRef);"),
 ("M40", "payNative uint128 guard off-by-one (> -> >=)",
  "if (msg.value > type(uint128).max) revert", "if (msg.value >= type(uint128).max) revert"),
 ("M41", "payWithAuthorization without nonReentrant",
  "        external\n        nonReentrant\n        returns (uint32 index)\n    {\n        bytes32 key;",
  "        external\n        returns (uint32 index)\n    {\n        bytes32 key;"),
 ("M42", "settlement nonce in _receiveAndForward ignores payerSalt (view unchanged)",
  "bytes32 nonce = _paymentNonce(key, auth.payer, auth.amount, auth.payerRef, auth.payerSalt);",
  "bytes32 nonce = _paymentNonce(key, auth.payer, auth.amount, auth.payerRef, bytes32(0));"),
 ("M43", "statesOf: no batch cap at all",
  "        if (n > MAX_BATCH) revert BatchTooLarge(MAX_BATCH);\n", ""),
 ("M44", "payments counter increment unchecked (wraps at 2^32 on unlimited links)",
  "st.payments = index + 1;", "unchecked { st.payments = index + 1; }"),
 ("M45", "total accumulation unchecked",
  "st.total += amount;", "unchecked { st.total += amount; }"),
 ("P1", "check order: InvalidSignature moved after Expired",
  _SRC[_SRC.index(_SIG):_SRC.index(_EXP) + len(_EXP)],
  _SRC[_SRC.index(_SIG):_SRC.index(_EXP) + len(_EXP)].replace(_SIG, "").replace(_EXP, _EXP + _SIG)),
 ("P2", "check order: SoldOut before NotYetValid/Expired",
  "        if (block.timestamp < inv.validAfter) revert NotYetValid(inv.validAfter);",
  "        if (inv.maxPayments != 0 && st.payments >= inv.maxPayments) revert SoldOut(inv.maxPayments);\n        if (block.timestamp < inv.validAfter) revert NotYetValid(inv.validAfter);"),
 ("P3", "check order: Cancelled before WrongPaymentPath",
  "        if ((inv.token == address(0)) != native) revert WrongPaymentPath();\n\n        key = _invoiceKey(inv);\n        LinkState memory st = _states[key];\n\n        if (st.cancelled) revert Cancelled();",
  "        key = _invoiceKey(inv);\n        LinkState memory st = _states[key];\n\n        if (st.cancelled) revert Cancelled();\n        if ((inv.token == address(0)) != native) revert WrongPaymentPath();"),
 ("P4", "check order: WrongPaymentPath before InvalidInvoice",
  "        _checkShape(inv);\n        if ((inv.token == address(0)) != native) revert WrongPaymentPath();",
  "        if ((inv.token == address(0)) != native) revert WrongPaymentPath();\n        _checkShape(inv);"),
]


def _defer_effects(record: str, interaction: str) -> tuple[str, str]:
    """`record` then `interaction`, rewritten so that the interaction runs with the pre-payment state in storage and
    the post-payment state is written back afterwards (the deferred-SSTORE mutant of one settlement path)."""
    key = "_states[_invoiceKey(inv)]"
    return (
        record + interaction,
        f"        LinkState memory pre__ = {key};\n" + record
        + f"        LinkState memory post__ = {key};\n        {key} = pre__;\n" + interaction
        + f"        {key} = post__;\n",
    )


_REC_NATIVE = (
    "        // forge-lint: disable-next-line(unsafe-typecast)\n"
    "        (, index) = _record(inv, payeeSig, true, msg.sender, uint128(msg.value), payerRef);\n"
)
_INT_NATIVE = (
    "        // The destination is the payee whose signature `_record` just verified, and the value is the caller's own.\n"
    "        // forge-lint: disable-next-line(arbitrary-send-eth)\n"
    "        Address.sendValue(payable(inv.payee), msg.value);\n"
)
_REC_AUTH = "        (key, index) = _record(inv, payeeSig, false, auth.payer, auth.amount, auth.payerRef);\n"
_INT_AUTH = "        _receiveAndForward(IERC20(inv.token), inv.payee, key, auth);\n"
_REC_PAY = "        (, index) = _record(inv, payeeSig, false, msg.sender, amount, payerRef);\n"
_INT_PERMIT = (
    "\n        // The permit is an interaction, so it runs after the effects. Its failure is ignored on purpose: if a\n"
    "        // third party front-ran it, the allowance already exists; otherwise `transferFrom` reverts below.\n"
    "        try IERC20Permit(inv.token).permit(msg.sender, address(this), amount, p.deadline, p.v, p.r, p.s) {} catch {}\n\n"
    "        _pullExact(IERC20(inv.token), msg.sender, inv.payee, amount);\n"
)
_PAY_OLD, _PAY_NEW = _defer_effects(_REC_PAY, "        _pullExact(IERC20(inv.token), msg.sender, inv.payee, amount);\n")
_PERMIT_OLD, _PERMIT_NEW = _defer_effects(_REC_PAY, _INT_PERMIT)
MUTANTS += [
 ("M46", "payNative: link-state write deferred past sendValue (the payee's receive reads stale state)",
  *_defer_effects(_REC_NATIVE, _INT_NATIVE)),
 ("M47", "payWithAuthorization: link-state write deferred past the token calls",
  *_defer_effects(_REC_AUTH, _INT_AUTH)),
 # `pay` and `payWithPermit` share the `_record` line, so each mutant also matches what follows it.
 ("M48", "pay: link-state write deferred past transferFrom",
  _PAY_OLD + "    }\n\n    /// @inheritdoc IPayLinkV2\n    function payWithPermit(",
  _PAY_NEW + "    }\n\n    /// @inheritdoc IPayLinkV2\n    function payWithPermit("),
 ("M49", "payWithPermit: link-state write deferred past permit and transferFrom", _PERMIT_OLD, _PERMIT_NEW),
]

# One-sided exactness checks (I1 and I6 are equalities).
_RECV = "        if (received != auth.amount) revert ReceivedMismatch(auth.amount, received);\n"
_CONS = "        if (balanceAfter != balanceBefore) revert ReceivedMismatch(balanceBefore, balanceAfter);\n"
_RECV_TO_CONS = _SRC[_SRC.index(_RECV):_SRC.index(_CONS) + len(_CONS)]
_PULL = (
    "        token.safeTransferFrom(from, payee, amount);\n"
    "        uint256 credited = _increase(balanceBefore, token.balanceOf(payee));\n"
    "        if (credited != amount)"
)
_PUSH = (
    "        token.safeTransfer(payee, amount);\n"
    "        uint256 credited = _increase(balanceBefore, token.balanceOf(payee));\n"
    "        if (credited != amount)"
)
# The payer argument of the three caller-pays paths, each matched with what follows it to be unique.
_PAY_BODY = (
    "        (, index) = _record(inv, payeeSig, false, msg.sender, amount, payerRef);\n"
    "        _pullExact(IERC20(inv.token), msg.sender, inv.payee, amount);\n"
)
_PERMIT_BODY = _REC_PAY + _INT_PERMIT
MUTANTS += [
 ("M50", "conservation post-check one-sided (!= -> <): PayLink's balance may grow across a call",
  _CONS, _CONS.replace("balanceAfter != balanceBefore", "balanceAfter < balanceBefore")),
 ("M51", "receive check one-sided (!= -> <): PayLink may receive more than authorized",
  _RECV, _RECV.replace("received != auth.amount", "received < auth.amount")),
 ("M52", "_pullExact one-sided (!= -> <): payee over-credit accepted on pay and payWithPermit",
  _PULL, _PULL.replace("credited != amount", "credited < amount")),
 ("M53", "_pushExact one-sided (!= -> <): payee over-credit accepted on the EIP-3009 forward leg",
  _PUSH, _PUSH.replace("credited != amount", "credited < amount")),
 ("M54", "receive check and conservation post-check both one-sided: an over-delivering token settles and PayLink "
  "keeps the surplus",
  _RECV_TO_CONS,
  _RECV_TO_CONS.replace("received != auth.amount", "received < auth.amount")
  .replace("balanceAfter != balanceBefore", "balanceAfter < balanceBefore")),
 ("M55", "cancel also authorizes tx.origin == payee (a lured payee's links can be cancelled)",
  "        if (msg.sender != inv.payee) revert NotPayee();\n",
  "        if (msg.sender != inv.payee && tx.origin != inv.payee) revert NotPayee();\n"),
 ("M56", "cancelBySig: tx.origin == payee stands in for the payee's signature",
  "        if (!SignatureChecker.isValidSignatureNow(inv.payee, digest, payeeSig)) revert InvalidSignature();\n",
  "        if (tx.origin != inv.payee && !SignatureChecker.isValidSignatureNow(inv.payee, digest, payeeSig)) {\n"
  "            revert InvalidSignature();\n        }\n"),
 ("M57", "pay: the payer is tx.origin (a lured payer's standing allowance can be spent)",
  _PAY_BODY, _PAY_BODY.replace("msg.sender", "tx.origin")),
 ("M58", "payWithPermit: the payer and permit owner are tx.origin",
  _PERMIT_BODY, _PERMIT_BODY.replace("msg.sender", "tx.origin")),
 ("M59", "payNative: the payer recorded (Paid, SelfPayment) is tx.origin",
  "(, index) = _record(inv, payeeSig, true, msg.sender, uint128(msg.value), payerRef);",
  "(, index) = _record(inv, payeeSig, true, tx.origin, uint128(msg.value), payerRef);"),
]

