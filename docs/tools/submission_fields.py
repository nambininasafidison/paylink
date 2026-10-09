#!/usr/bin/env python3
"""Character counts of the paste-ready submission fields in docs/submissions/*.md.

A field is a fenced ```text block preceded by a marker comment, and followed by its count line:

    <!-- field: monad.one-line max=200 -->
    ```text
    The text to paste.
    ```
    Characters: 185 / 200

The count is the number of Unicode code points of the text between the fences (its last newline excluded), which is
what a form that counts characters sees; a form that counts UTF-16 units sees the same number for this text, which has
no character outside the Basic Multilingual Plane. `max=0` means the form states no limit.

    python3 docs/tools/submission_fields.py           # check: each count line is right and within its limit
    python3 docs/tools/submission_fields.py --update  # rewrite the count lines after editing a field
    python3 docs/tools/submission_fields.py --list    # every field with its count

check-docs.py runs the check. Standard library only.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SUBMISSIONS = ROOT / "docs" / "submissions"
FIELD_RE = re.compile(
    r"<!-- field: (?P<id>[\w.-]+) max=(?P<max>\d+) -->\n```text\n(?P<body>.*?)\n```\n(?P<count>Characters: [^\n]*)", re.S
)


def count_line(n: int, limit: int) -> str:
    return f"Characters: {n:,} / {limit:,}" if limit else f"Characters: {n:,} (no stated limit)"


def fields(path: Path) -> list[tuple[str, int, int, str]]:
    """(id, characters, limit, count line as written) for every field of one document."""
    text = path.read_text(encoding="utf-8")
    return [(m["id"], len(m["body"]), int(m["max"]), m["count"]) for m in FIELD_RE.finditer(text)]


def problems(path: Path) -> list[str]:
    out: list[str] = []
    text = path.read_text(encoding="utf-8")
    markers = len(re.findall(r"<!-- field: ", text))
    found = fields(path)
    if markers != len(found):
        out.append(f"{path.name}: {markers} field markers but {len(found)} well-formed fields (marker, text fence, count line)")
    seen: set[str] = set()
    for field_id, n, limit, written in found:
        if field_id in seen:
            out.append(f"{path.name}: field {field_id} appears twice")
        seen.add(field_id)
        if limit and n > limit:
            out.append(f"{path.name}: {field_id} has {n:,} characters, over its limit of {limit:,}")
        if written != count_line(n, limit):
            out.append(f"{path.name}: {field_id} says '{written}', the text has {n:,} (run with --update)")
    return out


def update(path: Path) -> None:
    text = path.read_text(encoding="utf-8")

    def fix(m: re.Match[str]) -> str:
        return m.group(0)[: -len(m["count"])] + count_line(len(m["body"]), int(m["max"]))

    new = FIELD_RE.sub(fix, text)
    if new != text:
        path.write_text(new, encoding="utf-8")


def documents() -> list[Path]:
    return sorted(SUBMISSIONS.glob("*.md")) if SUBMISSIONS.is_dir() else []


def main(argv: list[str]) -> int:
    if "--update" in argv:
        for path in documents():
            update(path)
    if "--list" in argv:
        for path in documents():
            for field_id, n, limit, _ in fields(path):
                print(f"{path.name:18} {field_id:32} {n:6,} / {limit:,}" if limit else f"{path.name:18} {field_id:32} {n:6,}")
    errors = [p for path in documents() for p in problems(path)]
    for e in errors:
        print("error:", e)
    print(f"submission fields: {sum(len(fields(p)) for p in documents())} fields, {len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
