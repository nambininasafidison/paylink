#!/usr/bin/env python3
"""Paste-ready submission fields in docs/submissions/*.md, checked against the forms they are pasted into.

A field is a fenced ```text block preceded by a marker comment and followed by its count line:

    <!-- field: monad.one-line max=200 -->
    ```text
    The text to paste.
    ```
    Characters: 185 / 200

The marker names the field and its kind; the count line says what the block holds against the form's limit, and
--update rewrites it.

    kind        the block holds                                     count line
    max=N       text of at most N characters (0: no stated limit)   Characters: 185 / 200  (or: 9,431 (no stated limit))
    tags=N      one tag per line, at most N, none repeated          Tags: 23 / 25
    choice      exactly one of the form's options                   One of: New · Existing
    choices     one or more of the form's options, one per line     Any of: AG Grid · … · None, used other AI tools.
    scale=L-H   one whole number from L to H                        Scale: 1 to 10
    url         one https address                                   URL: one https address
    links       https addresses, one per line                       Links: 2 https addresses
    select      one line, picked from a list the form holds         Select: one line from the form's list

Characters are the Unicode code points between the fences (the last newline excluded), which is what a form that
counts characters sees; a form that counts UTF-16 units sees the same number for these texts, which have no character
outside the Basic Multilingual Plane.

FORMS holds the forms known field by field: today the PayPal AI Hackathon's Devpost form, as the owner's browser agent
read it on 2026-10-29 after "Start project" (docs/submissions/paypal.md §3). For a document with a form:

- every field of the document is a field of the form, with the form's kind, limit and options, in the form's order;
- every required field that is pasted (text, tags, a choice, a scale, an address) is in the document;
- every field of the form, pasted or filled by the owner himself (a file, an image, the video, a checkbox), is named
  in the document by the form's own words, so that no field of the form is left out.

A document without a form (the Monad, Colosseum and Mezo packs) holds text and tag fields only, checked against the
limits its markers state.

    python3 docs/tools/submission_fields.py           # check every document
    python3 docs/tools/submission_fields.py --update  # rewrite the count lines after editing a field
    python3 docs/tools/submission_fields.py --list    # every field with its count
    python3 docs/tools/submission_fields_test.py      # the tests of this file

check-docs.py runs the check (check 9). Standard library only.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SUBMISSIONS = ROOT / "docs" / "submissions"

KIND_RE = r"max=\d+|tags=\d+|scale=\d+-\d+|choices|choice|url|links|select"
COUNT_RE = r"(?:Characters|Tags|One of|Any of|Scale|URL|Links|Select): [^\n]*"
FIELD_RE = re.compile(
    rf"<!-- field: (?P<id>[\w.-]+) (?P<kind>{KIND_RE}) -->\n```text\n(?P<body>.*?)\n```\n(?P<count>{COUNT_RE})", re.S
)
MARKER_RE = re.compile(r"<!-- field: ")
HTTPS_RE = re.compile(r"https://[^\s<>\"'`]+")
TEXT_KINDS = ("max", "tags")  # the kinds a document without a form may use


# --------------------------------------------------------------------------- forms


@dataclass(frozen=True)
class FormField:
    """One field of a form. `id` is its marker's id; "" for a field the owner fills himself (kind "owner")."""

    label: str  # the form's own words (case aside), which the document must contain
    kind: str  # "max", "tags", "choice", "choices", "scale", "url", "links", "select" or "owner"
    required: bool
    id: str = ""
    limit: int = 0  # characters for "max" (0: no stated limit), tags for "tags"
    options: tuple[str, ...] = ()  # for "choice" and "choices"
    low: int = 0  # for "scale"
    high: int = 0
    names: tuple[tuple[str, str], ...] = ()  # (pattern, what): what the text must name, as the organisers ask

    def marker(self) -> str:
        """The kind a document's marker must state for this field."""
        if self.kind in ("max", "tags"):
            return f"{self.kind}={self.limit}"
        if self.kind == "scale":
            return f"scale={self.low}-{self.high}"
        return self.kind


@dataclass(frozen=True)
class Form:
    title: str
    source: str
    fields: tuple[FormField, ...]


def _owner(label: str, required: bool) -> FormField:
    return FormField(label, "owner", required)


# The update "Two weeks to go" (read on 2026-10-29) asks every entry to name PayPal and the AI in its description and
# in Built with (and in the video, which no tool can read).
NAMES_PAYPAL_AND_AI = ((r"\bPayPal\b", "PayPal"), (r"\bAI\b", "the AI"))
TAGS_PAYPAL_AND_AI = ((r"(?im)^paypal\b", "PayPal (a tag starting with paypal)"), (r"(?im)(?:^|-)ai(?:-|$)", "the AI (a tag ai, or ending in -ai)"))

# The PayPal AI Hackathon on Devpost, in the form's order. Labels are the form's words as the owner's browser agent
# recorded them on 2026-10-29 (summarised in docs/submissions/paypal.md §1 and §3); where it described a field
# instead of quoting it (the repository and demo addresses, the three eligibility checkboxes, the optional APIMatic
# and AG Grid questions), the label is its description.
PAYPAL_FORM = Form(
    title="the PayPal AI Hackathon's Devpost form",
    source='read by the owner\'s browser agent on 2026-10-29, after "Start project" (private draft, nothing submitted)',
    fields=(
        # Step 1: Manage team
        _owner("Manage team", False),
        # Step 2: Project overview
        FormField("Project name", "max", True, id="paypal.name", limit=60),
        FormField("Elevator pitch", "max", True, id="paypal.pitch", limit=200, names=NAMES_PAYPAL_AND_AI),
        _owner("Thumbnail", False),
        # Step 3: Project details (the public page)
        FormField("About the project", "max", True, id="paypal.story", limit=0, names=NAMES_PAYPAL_AND_AI),
        FormField("Built with", "tags", True, id="paypal.built-with", limit=25, names=TAGS_PAYPAL_AND_AI),
        FormField('"Try it out" links', "links", False, id="paypal.try-it"),
        _owner("Image gallery", False),
        _owner("Demo video", True),
        # Step 4: Additional info (for judges and organizers; only the country appears in the project gallery)
        _owner("Upload a File", False),
        FormField("Submitter Type", "choice", True, id="paypal.submitter-type", options=("Individual", "Team", "Organization")),
        FormField("Submitter Country of Residence", "select", True, id="paypal.country"),
        FormField("Canada province", "max", True, id="paypal.province", limit=0),
        FormField("Organization Name", "max", True, id="paypal.organization", limit=0),
        FormField(
            "Is your project new, or did it exist before Oct 1, 2026 (9:15 am PT)?",
            "choice",
            True,
            id="paypal.new-or-existing",
            options=("New", "Existing"),
        ),
        FormField(
            "If it existed before, explain what already existed and what you built or changed during the submission period.",
            "max",
            True,
            id="paypal.existed-before",
            limit=0,
        ),
        FormField("Explain how your project meets the main technology requirement.", "max", True, id="paypal.main-technology", limit=0),
        FormField(
            "Which additional sponsor tool(s) did you use for this project?",
            "choices",
            True,
            id="paypal.sponsor-tools",
            options=(
                "AG Grid",
                "APIMatic",
                "Astropods",
                "Bryntum",
                "Channel3",
                "Elastic",
                "KERNEL",
                "Postman",
                "Render",
                "Zapier",
                "None, used other AI tools.",
            ),
        ),
        FormField("public code repository URL", "url", True, id="paypal.repository"),
        FormField("working demo URL", "url", True, id="paypal.demo"),
        FormField(
            "Testing instructions or credentials the judges need to test your project, if any.",
            "max",
            False,
            id="paypal.testing",
            limit=0,
        ),
        FormField("How would you rate your overall experience integrating PayPal?", "scale", True, id="paypal.rating", low=1, high=10),
        FormField(
            "Overall experience rating: Please share why or provide additional feedback.", "max", True, id="paypal.rating-why", limit=0
        ),
        FormField(
            "Are you open to us contacting you for additional feedback regarding your experience with integrating PayPal?",
            "choice",
            True,
            id="paypal.contact",
            options=("Yes", "No"),
        ),
        _owner("APIMatic Context Plugin and AG Grid experience", False),
        _owner("age of majority", True),
        _owner("eligible jurisdiction", True),
        _owner("not an employee, representative or agent of the Promotion Entities", True),
        FormField("Which AI tools have you leveraged while working on this project?", "max", True, id="paypal.ai-tools", limit=0),
        FormField(
            "Describe the level of learning you/your team derived from the project",
            "choice",
            True,
            id="paypal.learning",
            options=("None", "Moderate", "Significant"),
        ),
        FormField("Did you gain AI value that you can use in your career?", "choice", True, id="paypal.ai-value", options=("Yes", "No")),
        # Step 5: Submit
        _owner(
            "I, and all of my team members, have read and agree to be bound by the Official Rules and the Devpost Terms of Service.",
            True,
        ),
    ),
)

FORMS: dict[str, Form] = {"paypal.md": PAYPAL_FORM}


# --------------------------------------------------------------------------- fields of a document


@dataclass(frozen=True)
class Field:
    id: str
    kind: str  # as the marker states it: "max=200", "choice", ...
    body: str
    count: str  # the count line as written


def kind_name(kind: str) -> str:
    return kind.split("=", 1)[0]


def _number(kind: str) -> int:
    return int(kind.split("=", 1)[1])


def _scale(kind: str) -> tuple[int, int]:
    low, high = kind.split("=", 1)[1].split("-", 1)
    return int(low), int(high)


def parse(text: str) -> list[Field]:
    return [Field(m["id"], m["kind"], m["body"], m["count"]) for m in FIELD_RE.finditer(text)]


def fields(path: Path) -> list[Field]:
    return parse(path.read_text(encoding="utf-8"))


def form_for(path: Path) -> Form | None:
    return FORMS.get(path.name)


def count_line(field: Field, form_field: FormField | None = None) -> str:
    """The count line `field` should have, from its body, its marker and its form field (for the options)."""
    name = kind_name(field.kind)
    if name == "max":
        n, limit = len(field.body), _number(field.kind)
        return f"Characters: {n:,} / {limit:,}" if limit else f"Characters: {n:,} (no stated limit)"
    if name == "tags":
        return f"Tags: {len(field.body.split(chr(10))):,} / {_number(field.kind):,}"
    if name in ("choice", "choices"):
        options = " · ".join(form_field.options) if form_field is not None else "(no form)"
        return f"{'One of' if name == 'choice' else 'Any of'}: {options}"
    if name == "scale":
        low, high = _scale(field.kind)
        return f"Scale: {low} to {high}"
    if name == "url":
        return "URL: one https address"
    if name == "links":
        n = len(field.body.split("\n"))
        return f"Links: {n} https address{'' if n == 1 else 'es'}"
    return "Select: one line from the form's list"


def body_problems(field: Field, form_field: FormField | None) -> list[str]:
    """What is wrong with the text of `field` for its kind (and its form field's options)."""
    name, body, out = kind_name(field.kind), field.body, []
    lines = body.split("\n")
    if name == "max":
        limit = _number(field.kind)
        if limit and len(body) > limit:
            out.append(f"{field.id} has {len(body):,} characters, over its limit of {limit:,}")
    elif name == "tags":
        limit = _number(field.kind)
        if any(tag.strip() == "" or tag != tag.strip() for tag in lines):
            out.append(f"{field.id} has an empty tag or a tag with spaces around it (one tag per line)")
        if len(lines) > limit:
            out.append(f"{field.id} has {len(lines)} tags, over the form's {limit}")
        seen: set[str] = set()
        for tag in lines:
            if tag.lower() in seen:
                out.append(f"{field.id} repeats the tag '{tag}'")
            seen.add(tag.lower())
    elif name == "choice":
        if form_field is not None and body not in form_field.options:
            out.append(f"{field.id} answers '{body}', which is not one of the form's options")
    elif name == "choices":
        if form_field is not None:
            for picked in lines:
                if picked not in form_field.options:
                    out.append(f"{field.id} picks '{picked}', which is not one of the form's options")
            if len(set(lines)) != len(lines):
                out.append(f"{field.id} picks an option twice")
            if len(lines) > 1 and any(picked.startswith("None") for picked in lines):
                out.append(f"{field.id} picks 'None' together with another option")
    elif name == "scale":
        low, high = _scale(field.kind)
        if not re.fullmatch(r"\d+", body) or not low <= int(body) <= high:
            out.append(f"{field.id} answers '{body}', not a whole number from {low} to {high}")
    elif name == "url":
        if not HTTPS_RE.fullmatch(body):
            out.append(f"{field.id} is not one https address")
    elif name == "links":
        for line in lines:
            if not HTTPS_RE.fullmatch(line):
                out.append(f"{field.id} has '{line}', not an https address on a line of its own")
    elif name == "select":
        if len(lines) != 1 or body.strip() == "" or body != body.strip():
            out.append(f"{field.id} is not one line")
    for pattern, what in form_field.names if form_field is not None else ():
        if not re.search(pattern, body):
            out.append(f"{field.id} does not name {what}")
    return out


def form_problems(text: str, found: list[Field], form: Form) -> list[str]:
    """What the document lacks or adds against its form."""
    out: list[str] = []
    by_id = {f.id: f for f in form.fields if f.id}
    order = [f.id for f in form.fields if f.id]
    for field in found:
        form_field = by_id.get(field.id)
        if form_field is None:
            out.append(f"{field.id} is not a field of {form.title}")
        elif field.kind != form_field.marker():
            out.append(f"{field.id} is marked {field.kind}; in {form.title} it is {form_field.marker()}")
    present = [field.id for field in found if field.id in by_id]
    if present != sorted(present, key=order.index):
        out.append(f"the fields are not in the order of {form.title}: {', '.join(present)}")
    ids = {field.id for field in found}
    lowered = text.lower()
    for form_field in form.fields:
        if form_field.id and form_field.required and form_field.id not in ids:
            out.append(f'the required field "{form_field.label}" ({form_field.id}) is missing')
        if form_field.label.lower() not in lowered:
            what = "filled by the owner" if form_field.kind == "owner" else form_field.id
            out.append(f'the form\'s field "{form_field.label}" ({what}) is not named in the document')
    return out


def problems_in(name: str, text: str, form: Form | None) -> list[str]:
    """Every problem of one document's text, each prefixed with `name`."""
    out: list[str] = []
    found = parse(text)
    markers = len(MARKER_RE.findall(text))
    if markers != len(found):
        out.append(f"{markers} field markers but {len(found)} well-formed fields (marker, text fence, count line)")
    by_id = {f.id: f for f in form.fields if f.id} if form is not None else {}
    seen: set[str] = set()
    for field in found:
        if field.id in seen:
            out.append(f"field {field.id} appears twice")
        seen.add(field.id)
        if form is None and kind_name(field.kind) not in TEXT_KINDS:
            out.append(f"{field.id} is a {kind_name(field.kind)} field, which needs its form in FORMS")
            continue
        form_field = by_id.get(field.id)
        out.extend(body_problems(field, form_field))
        expected = count_line(field, form_field)
        if field.count != expected:
            out.append(f"{field.id} says '{field.count}', it should say '{expected}' (run with --update)")
    if form is not None:
        out.extend(form_problems(text, found, form))
    return [f"{name}: {problem}" for problem in out]


def problems(path: Path) -> list[str]:
    return problems_in(path.name, path.read_text(encoding="utf-8"), form_for(path))


def updated(text: str, form: Form | None) -> str:
    """`text` with every count line rewritten."""
    by_id = {f.id: f for f in form.fields if f.id} if form is not None else {}

    def fix(m: re.Match[str]) -> str:
        field = Field(m["id"], m["kind"], m["body"], m["count"])
        return m.group(0)[: -len(m["count"])] + count_line(field, by_id.get(field.id))

    return FIELD_RE.sub(fix, text)


def update(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    new = updated(text, form_for(path))
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
            for field in fields(path):
                print(f"{path.name:18} {field.id:28} {field.count}")
    errors = [p for path in documents() for p in problems(path)]
    for e in errors:
        print("error:", e)
    print(f"submission fields: {sum(len(fields(p)) for p in documents())} fields, {len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
