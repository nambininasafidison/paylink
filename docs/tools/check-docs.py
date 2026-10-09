#!/usr/bin/env python3
"""Consistency checks for the PayLink documentation set.

Run from anywhere:  python3 docs/tools/check-docs.py [--strict] [extra.md ...]

Documents: docs/**/*.md, the root policy files, protocol/ and protocol/audit/ Markdown, the deployments README and
every packages/*/README.md and apps/*/README.md. Checks, each reported with file and reason:

1. links     Relative links resolve to a file, and every #fragment matches a heading (GitHub slug rules) or an
             explicit <a id="..."> anchor in the target Markdown file.
2. tests     Every Foundry test cited in the documents (`test_*`, `testFuzz_*`, `invariant_*`, optionally
             prefixed with `File.t.sol::`) exists under protocol/test, in the named file when one is given.
3. addresses Every EVM address in the documents is listed in docs/tools/address-allowlist.json; mixed-case
             addresses carry a valid EIP-55 checksum; an address marked `never` only appears on a line that says
             it must not be used.
4. adrs      Every docs/adr/NNNN-*.md is listed in docs/adr/README.md and in ARCHITECTURE.md §13, with the
             same status as its own header.
5. schema    docs/spec/paylink-invoice-v2.schema.json is a valid JSON Schema 2020-12 document, its example
             validates, and it is identical to the example in specification §11.3. Needs the `jsonschema`
             package; without it the check is skipped with a warning (an error with --strict).
6. paths     Every backticked repository path in the documents (`protocol/...`, `packages/...`, `apps/...`,
             `e2e/...`, `docs/...`, `scripts/...`, `.github/...`; globs and `<placeholders>` excepted) exists,
             unless the same item (a table cell or a line, split at semicolons) marks it *planned (Tn)*.
             Paths into an area that is not built yet (`apps/<name>`, `packages/<name>`, `e2e/`, `.github/`)
             describe the design and are checked from the moment that area exists. Build outputs that git ignores
             (`protocol/out`, `protocol/cache`, `protocol/crytic-export`, `protocol/lcov.info`) are never required:
             a clean checkout has none of them.
7. evidence  In THREAT_MODEL.md (§6 evidence column, §7 test column), every evidence item that is not a Foundry
             test or a file (e2e specs, relayer tests, CI workflows, drills, reviews of things not built yet)
             either cites an existing path or carries a *planned (Tn)* marker; a marker on an item whose cited
             path exists is stale. Once e2e/ or apps/ exists, a *planned* e2e or relayer item is reported (a
             warning; an error with --strict) until it cites the spec file that now exists.
8. stale     Rules that an audit superseded must not come back as normative text: a new `payerSalt` per retry
             (replaced by "resubmit the same authorisation", spec §8.6, finding A-01; ADR 0003 kept it until the
             re-audit), a relay revert banning key, payee and payer together, and the claim that bans cost an
             attacker a fresh payee, payer and card (replaced by attribution by cause, spec §13.3, finding A-04).
             A line that records the change as history (it says "no longer", "claimed", "revised", "amended", ...)
             is exempt.
9. fields    Every paste-ready field of docs/submissions/*.md (a marked ```text block) carries a count line that matches
             its text and stays within the form's limit (docs/tools/submission_fields.py, which also rewrites the counts).

The spec's literal test vectors (§7.6, §17) are checked by the contract suite instead:
protocol/test/vectors/SpecExamples.t.sol.

Exit status: 0 when every check passes, 1 otherwise. Standard library only (plus optional jsonschema).
"""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
POLICY_FILES = ["SECURITY.md", "NOTICE.md", "AI_DISCLOSURE.md", "CONTRIBUTING.md", "CHANGELOG.md"]

errors: list[str] = []
warnings: list[str] = []


def err(check: str, where: Path | str, msg: str) -> None:
    errors.append(f"[{check}] {rel(where)}: {msg}")


def rel(p: Path | str) -> str:
    try:
        return str(Path(p).resolve().relative_to(ROOT))
    except ValueError:
        return str(p)


def strip_code(text: str) -> str:
    """Remove fenced code blocks, keeping line numbers stable."""
    return re.sub(r"```.*?```", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)


# --------------------------------------------------------------------------- 1. links


def slug(heading: str) -> str:
    text = re.sub(r"`([^`]*)`", r"\1", heading)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text).strip().lower()
    out = []
    for ch in text:
        if ch == " ":
            out.append("-")
        elif ch in "-_" or unicodedata.category(ch)[0] in ("L", "N") or unicodedata.category(ch) == "Mn":
            out.append(ch)
    return "".join(out)


_anchor_cache: dict[Path, set[str]] = {}


def anchors(path: Path) -> set[str]:
    if path in _anchor_cache:
        return _anchor_cache[path]
    found: set[str] = set()
    seen: dict[str, int] = {}
    for line in strip_code(path.read_text(encoding="utf-8")).splitlines():
        m = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", line)
        if m:
            s = slug(m.group(2))
            n = seen.get(s, 0)
            found.add(s if n == 0 else f"{s}-{n}")
            seen[s] = n + 1
        found.update(re.findall(r'<a id="([^"]+)"', line))
    _anchor_cache[path] = found
    return found


LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)|^\[[^\]]+\]:\s*(\S+)", re.M)


def check_links(md: Path) -> None:
    text = strip_code(md.read_text(encoding="utf-8"))
    for m in LINK_RE.finditer(text):
        target = m.group(1) or m.group(2)
        if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("<"):
            continue
        path, _, frag = target.partition("#")
        dest = (md.parent / path).resolve() if path else md.resolve()
        if not dest.exists():
            err("links", md, f"missing target {target}")
            continue
        if frag and dest.suffix == ".md" and frag not in anchors(dest):
            err("links", md, f"missing anchor {target}")


# --------------------------------------------------------------------------- 2. tests

TEST_RE = re.compile(r"(?:([A-Za-z0-9_]+\.t\.sol)::)?\b((?:test|testFuzz|invariant)_[A-Za-z0-9_]+)")


def test_index() -> dict[str, set[str]]:
    index: dict[str, set[str]] = {}
    test_dir = ROOT / "protocol" / "test"
    if not test_dir.is_dir():
        return index
    for sol in test_dir.rglob("*.sol"):
        for name in re.findall(r"function\s+((?:test|testFuzz|invariant)_[A-Za-z0-9_]+)\s*\(", sol.read_text()):
            index.setdefault(name, set()).add(sol.name)
    return index


def check_tests(md: Path, index: dict[str, set[str]]) -> None:
    if not index:
        return
    for lineno, line in enumerate(md.read_text(encoding="utf-8").splitlines(), 1):
        for m in TEST_RE.finditer(line):
            file, name = m.group(1), m.group(2)
            if name not in index:
                err("tests", md, f"line {lineno}: cites {name}, which does not exist under protocol/test")
            elif file and file not in index[name]:
                where = ", ".join(sorted(index[name]))
                err("tests", md, f"line {lineno}: cites {file}::{name}, but {name} is defined in {where}")


# --------------------------------------------------------------------------- 3. addresses

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
    0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
    0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
    0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_MASK = (1 << 64) - 1


def _keccak_f(state: list[list[int]]) -> None:
    for rc in _RC:
        c = [state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ (((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)) & _MASK) for x in range(5)]
        for x in range(5):
            for y in range(5):
                state[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                r = _ROT[x][y]
                v = state[x][y]
                b[y][(2 * x + 3 * y) % 5] = ((v << r) | (v >> (64 - r))) & _MASK if r else v
        for x in range(5):
            for y in range(5):
                state[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        state[0][0] ^= rc


def keccak256(data: bytes) -> bytes:
    """Keccak-256 as used by Ethereum (original Keccak padding, not FIPS-202 SHA3)."""
    rate = 136
    msg = bytearray(data) + b"\x01"
    msg += b"\x00" * ((-len(msg)) % rate)
    msg[-1] |= 0x80
    state = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off : off + rate]
        for i in range(rate // 8):
            state[i % 5][i // 5] ^= int.from_bytes(block[8 * i : 8 * i + 8], "little")
        _keccak_f(state)
    return b"".join(state[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


def eip55(addr: str) -> str:
    hex_ = addr[2:].lower()
    digest = keccak256(hex_.encode()).hex()
    return "0x" + "".join(ch.upper() if ch.isalpha() and int(digest[i], 16) >= 8 else ch for i, ch in enumerate(hex_))


ADDR_RE = re.compile(r"(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")


def load_allowlist() -> dict[str, dict]:
    path = DOCS / "tools" / "address-allowlist.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    allow: dict[str, dict] = {}
    for entry in data["addresses"]:
        a = entry["address"]
        if a != a.lower() and a != eip55(a):
            err("addresses", path, f"{a} fails EIP-55 (expected {eip55(a)})")
        allow[a.lower()] = entry
    return allow


def check_addresses(f: Path, allow: dict[str, dict]) -> None:
    for lineno, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
        for a in ADDR_RE.findall(line):
            entry = allow.get(a.lower())
            if entry is None:
                err("addresses", f, f"line {lineno}: {a} is not in docs/tools/address-allowlist.json")
                continue
            if a != a.lower() and a != entry["address"]:
                err("addresses", f, f"line {lineno}: {a} differs in case from the checksummed {entry['address']}")
            if entry["use"] == "never" and not re.search(r"\bnot\b|\bnever\b|do not use", line, re.I):
                err("addresses", f, f"line {lineno}: {a} must only be mentioned as an address never to use")


# --------------------------------------------------------------------------- 4. ADR index


def check_adrs() -> None:
    adr_dir = DOCS / "adr"
    index = (adr_dir / "README.md").read_text(encoding="utf-8")
    arch = (DOCS / "ARCHITECTURE.md").read_text(encoding="utf-8")
    for adr in sorted(adr_dir.glob("[0-9][0-9][0-9][0-9]-*.md")):
        text = adr.read_text(encoding="utf-8")
        m = re.search(r"^status:\s*(.+)$", text, re.M) or re.search(r"\*\*Status:\*\*\s*(.+)$", text, re.M)
        status = m.group(1).strip().lower() if m else None
        row = re.search(rf"^\|\s*\[{adr.name[:4]}\]\({re.escape(adr.name)}\)\s*\|[^|]*\|\s*([^|]+?)\s*\|", index, re.M)
        if not row:
            err("adrs", adr_dir / "README.md", f"{adr.name} is not listed")
        elif status and row.group(1).lower() != status:
            err("adrs", adr_dir / "README.md", f"{adr.name} listed as '{row.group(1)}', header says '{status}'")
        if f"(adr/{adr.name})" not in arch:
            err("adrs", DOCS / "ARCHITECTURE.md", f"§13 does not link {adr.name}")


# --------------------------------------------------------------------------- 5. schema


def check_schema(strict: bool) -> None:
    schema_path = DOCS / "spec" / "paylink-invoice-v2.schema.json"
    spec_path = DOCS / "spec" / "paylink-invoice-v2.md"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    m = re.search(r"### 11\.3 Example.*?```json\n(.*?)```", spec_path.read_text(encoding="utf-8"), re.S)
    if not m:
        err("schema", spec_path, "§11.3 example not found")
    elif json.loads(m.group(1)) != schema.get("examples", [None])[0]:
        err("schema", schema_path, "examples[0] differs from the specification §11.3 example")
    try:
        from jsonschema import Draft202012Validator  # type: ignore[import-not-found]
    except ImportError:
        (err if strict else lambda c, w, msg: warnings.append(f"[{c}] {rel(w)}: {msg}"))(
            "schema", schema_path, "jsonschema is not installed; meta-schema and example validation skipped"
        )
        return
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    for i, example in enumerate(schema.get("examples", [])):
        for e in validator.iter_errors(example):
            err("schema", schema_path, f"examples[{i}] invalid: {e.message}")


# --------------------------------------------------------------------------- 6. paths and 7. evidence

PATH_PREFIXES = ("protocol/", "packages/", "apps/", "e2e/", "docs/", "scripts/", ".github/")
PLANNED_RE = re.compile(r"\*planned \((?:T[0-2])(?:[^)]*)\)\*")
BACKTICK_RE = re.compile(r"`([^`\s]+)`")


def cited_paths(text: str) -> list[str]:
    out = []
    for raw in BACKTICK_RE.findall(text):
        path = raw.split("::", 1)[0].rstrip(".,;:")
        if not path.startswith(PATH_PREFIXES) or any(c in path for c in "{}*<>|"):
            continue
        out.append(path)
    return out


# Build outputs (ignored by git, see .gitignore): documents may name them, but a clean checkout has none of them.
GENERATED_PATHS = ("protocol/out", "protocol/cache", "protocol/crytic-export", "protocol/lcov.info")


def is_generated(path: str) -> bool:
    path = path.rstrip("/")
    return any(path == g or path.startswith(g + "/") for g in GENERATED_PATHS)


def path_exists(path: str) -> bool:
    return (ROOT / path.rstrip("/")).exists()


def area_of(path: str) -> Path:
    """The unit a path belongs to: packages/<name> and apps/<name>, otherwise its top-level folder."""
    parts = path.rstrip("/").split("/")
    depth = 2 if parts[0] in ("packages", "apps") and len(parts) > 1 else 1
    return ROOT.joinpath(*parts[:depth])


def check_paths(md: Path) -> None:
    """A path into an area that exists must exist. Paths into areas not built yet (apps/web, e2e/, .github/, ...)
    describe the design and are not checked until the area exists; then every cited file must be there."""
    for lineno, line in enumerate(strip_code(md.read_text(encoding="utf-8")).splitlines(), 1):
        cells = line.split("|") if line.lstrip().startswith("|") else [line]
        items = [item for cell in cells for item in re.split(r";(?![^(]*\))", cell)]
        for item in items:
            if PLANNED_RE.search(item):
                continue
            for path in cited_paths(item):
                if is_generated(path):
                    continue
                # Package READMEs cite package-relative paths (`scripts/generate.ts`): accept either base.
                if area_of(path).exists() and not path_exists(path) and not (md.parent / path).exists():
                    err("paths", md, f"line {lineno}: cites {path}, which does not exist (mark it *planned (Tn)* if it is)")


# Evidence that is neither a Foundry test nor an existing file: it must exist as a path or be marked planned.
UNBUILT_RE = re.compile(
    r"\be2e\b|relayer (?:unit )?tests|\.yml\b|\bCI\b|status LEDs|incident drill|branch protection|workflow review|"
    r"scorecard|indexer handler tests|copy helpers|header test|injection test fixtures|testnet validation|fork-nightly",
    re.I,
)
CATEGORY_DIRS = {"e2e": ROOT / "e2e", "relayer": ROOT / "apps" / "relayer"}


def evidence_cells(md: Path) -> list[tuple[int, str]]:
    """(line, cell) for the evidence column of §6 (second to last) and the test column of §7 (last)."""
    cells: list[tuple[int, str]] = []
    section = ""
    for lineno, line in enumerate(md.read_text(encoding="utf-8").splitlines(), 1):
        if line.startswith("## "):
            section = line
        if not line.startswith("| ") or set(line.replace("|", "").strip()) <= set("-: "):
            continue
        parts = [c.strip() for c in line.strip().strip("|").split("|")]
        if section.startswith("## 6.") and len(parts) == 6 and parts[0] != "ID":
            cells.append((lineno, parts[4]))
        elif section.startswith("## 7.") and len(parts) == 3 and parts[0] != "Abuser story":
            cells.append((lineno, parts[2]))
    return cells


def check_evidence(strict: bool) -> None:
    md = DOCS / "security" / "THREAT_MODEL.md"
    for lineno, cell in evidence_cells(md):
        for item in [i.strip() for i in re.split(r";(?![^(]*\))", cell) if i.strip()]:
            planned = PLANNED_RE.search(item) is not None
            paths = cited_paths(item)
            existing = [p for p in paths if path_exists(p)]
            if planned and existing:
                err("evidence", md, f"line {lineno}: '{item[:60]}' is marked planned but cites {existing[0]}, which exists")
            if not UNBUILT_RE.search(item) or existing:
                continue
            if not planned:
                err("evidence", md, f"line {lineno}: '{item[:60]}' cites evidence that is not built; cite its path or mark it *planned (Tn)*")
                continue
            for category, folder in CATEGORY_DIRS.items():
                if re.search(rf"\b{category}\b", item, re.I) and folder.exists():
                    (err if strict else lambda c, w, msg: warnings.append(f"[{c}] {rel(w)}: {msg}"))(
                        "evidence", md, f"line {lineno}: {rel(folder)}/ exists now: cite the spec for '{item[:60]}' instead of *planned*"
                    )


# --------------------------------------------------------------------------- 8. stale

STALE_RULES: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(
            r"(?:fresh|new)\s+`?payerSalt`?\s+(?:for|per|on)\s+(?:each|every)\s+(?:attempt|retry)"
            r"|`?payerSalt`?\s+is\s+(?:fresh|new|drawn(?:\s+again)?)\s+(?:for|per|on)\s+(?:each|every)\s+(?:attempt|retry)",
            re.I,
        ),
        "superseded retry rule: payerSalt is drawn once per intended payment and a retry resubmits the same "
        "authorisation (spec §8.6, THREAT_MODEL T-45)",
    ),
    (
        re.compile(
            r"\bbans?\s+(?:the\s+)?(?:invoice\s+)?key,\s+(?:the\s+)?payee,?\s+and\s+(?:the\s+)?payer\b"
            r"|\bkey,\s+(?:the\s+)?payee\s+or\s+(?:the\s+)?payer\s+whose\s+relay\s+reverted",
            re.I,
        ),
        "superseded relayer rule: a post-simulation revert bans only the party its cause names (spec §13.3, T-13)",
    ),
    (
        re.compile(r"cost(?:s)?\s+the\s+attacker\s+a\s+fresh\s+payee,\s+payer\s+and\s+card", re.I),
        "false residual (finding A-04): a payer-side grief needed no fresh payee; see THREAT_MODEL T-13",
    ),
]
HISTORICAL_RE = re.compile(
    r"no longer|was wrong|claimed|asked for|used to|before the fix|amended|revised|replaced|instead of|the original", re.I
)


def check_stale(md: Path) -> None:
    for lineno, line in enumerate(strip_code(md.read_text(encoding="utf-8")).splitlines(), 1):
        if HISTORICAL_RE.search(line):
            continue
        for pattern, reason in STALE_RULES:
            if pattern.search(line):
                err("stale", md, f"line {lineno}: {reason}")


# --------------------------------------------------------------------------- 9. fields


def check_fields() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.dont_write_bytecode = True  # no __pycache__ in docs/tools
    import submission_fields  # noqa: E402  (a sibling script, imported by path)

    for path in submission_fields.documents():
        for problem in submission_fields.problems(path):
            err("fields", path, problem.split(": ", 1)[1])


# --------------------------------------------------------------------------- main


def main(argv: list[str]) -> int:
    strict = "--strict" in argv
    extra = [Path(a) for a in argv if not a.startswith("--")]
    evidence_docs = sorted((ROOT / "protocol").glob("*.md")) + sorted((ROOT / "protocol" / "audit").glob("*.md"))
    evidence_docs += sorted((ROOT / "protocol" / "deployments").glob("*.md")) + sorted((ROOT / "packages").glob("*/README.md"))
    evidence_docs += sorted((ROOT / "apps").glob("*/README.md"))
    md_files = sorted(DOCS.rglob("*.md")) + [ROOT / f for f in POLICY_FILES if (ROOT / f).exists()] + evidence_docs + extra
    json_files = sorted(DOCS.rglob("*.json"))
    index = test_index()
    allow = load_allowlist()
    for md in md_files:
        check_links(md)
        check_tests(md, index)
        check_addresses(md, allow)
        check_paths(md)
        check_stale(md)
    for js in json_files:
        if js.name != "address-allowlist.json":
            check_addresses(js, allow)
    check_adrs()
    check_schema(strict)
    check_evidence(strict)
    check_fields()
    for w in warnings:
        print("warning:", w)
    for e in errors:
        print("error:", e)
    cited = "" if index else " (protocol/test not found: test citations not checked)"
    print(f"check-docs: {len(md_files)} Markdown and {len(json_files)} JSON files, {len(errors)} error(s){cited}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
