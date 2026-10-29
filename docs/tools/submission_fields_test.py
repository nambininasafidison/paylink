#!/usr/bin/env python3
"""Tests of submission_fields.py: the field kinds, the PayPal Devpost form, and the committed packs.

    python3 docs/tools/submission_fields_test.py

Standard library only (unittest).
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # no __pycache__ in docs/tools
sys.path.insert(0, str(Path(__file__).resolve().parent))

import submission_fields as sf  # noqa: E402  (a sibling script, imported by path)

FORM = sf.PAYPAL_FORM
BY_ID = {f.id: f for f in FORM.fields if f.id}


def sample(form_field: sf.FormField) -> str:
    """A body that a form field accepts."""
    if form_field.kind == "max":
        return "PayPal and the AI: a sample text."
    if form_field.kind == "tags":
        return "paypal\ncloudflare-workers-ai\ntypescript"
    if form_field.kind == "choice":
        return form_field.options[0]
    if form_field.kind == "choices":
        return form_field.options[-1]
    if form_field.kind == "scale":
        return str(form_field.high)
    if form_field.kind == "url":
        return "https://example.org/"
    if form_field.kind == "links":
        return "https://example.org/a\nhttps://example.org/b"
    return "Madagascar"


def block(field_id: str, kind: str, body: str, form_field: sf.FormField | None) -> list[str]:
    count = sf.count_line(sf.Field(field_id, kind, body, ""), form_field)
    return [f"<!-- field: {field_id} {kind} -->", "```text", body, "```", count]


def document(
    bodies: dict[str, str] | None = None,
    kinds: dict[str, str] | None = None,
    drop: frozenset[str] = frozenset(),
    unnamed: frozenset[str] = frozenset(),
    order: list[str] | None = None,
    extra: list[str] | None = None,
) -> str:
    """A pack for the PayPal form: every field named and answered, unless told otherwise."""
    bodies, kinds = bodies or {}, kinds or {}
    lines = ["# A pack"]
    form_fields = list(FORM.fields)
    if order is not None:
        rank = {field_id: i for i, field_id in enumerate(order)}
        pasted = sorted((f for f in form_fields if f.id in rank), key=lambda f: rank[f.id])
        it = iter(pasted)
        form_fields = [next(it) if f.id in rank else f for f in form_fields]
    for form_field in form_fields:
        if form_field.label not in unnamed:
            lines.append(f"Field: {form_field.label}")
        if form_field.id and form_field.id not in drop:
            body = bodies.get(form_field.id, sample(form_field))
            lines += block(form_field.id, kinds.get(form_field.id, form_field.marker()), body, form_field)
    lines += extra or []
    return "\n".join(lines) + "\n"


def problems(text: str) -> list[str]:
    return sf.problems_in("paypal.md", text, FORM)


class PayPalFormTest(unittest.TestCase):
    """The form as the owner's browser agent read it on 2026-10-29."""

    def test_limits_of_the_real_form(self) -> None:
        self.assertEqual(BY_ID["paypal.name"].marker(), "max=60")
        self.assertEqual(BY_ID["paypal.pitch"].marker(), "max=200")
        self.assertEqual(BY_ID["paypal.story"].marker(), "max=0")
        self.assertEqual(BY_ID["paypal.built-with"].marker(), "tags=25")
        self.assertEqual(BY_ID["paypal.rating"].marker(), "scale=1-10")
        self.assertEqual(BY_ID["paypal.submitter-type"].options, ("Individual", "Team", "Organization"))
        self.assertEqual(BY_ID["paypal.new-or-existing"].options, ("New", "Existing"))
        self.assertEqual(BY_ID["paypal.learning"].options, ("None", "Moderate", "Significant"))
        self.assertEqual(len(BY_ID["paypal.sponsor-tools"].options), 11)
        self.assertIn("None, used other AI tools.", BY_ID["paypal.sponsor-tools"].options)

    def test_required_and_optional(self) -> None:
        optional = {f.label for f in FORM.fields if not f.required}
        self.assertTrue({"Thumbnail", "Image gallery", "Upload a File", '"Try it out" links'} <= optional)
        self.assertFalse(BY_ID["paypal.testing"].required)
        self.assertTrue(all(BY_ID[i].required for i in ("paypal.name", "paypal.pitch", "paypal.story", "paypal.built-with")))
        owner = {f.label for f in FORM.fields if f.kind == "owner" and f.required}
        self.assertIn("Demo video", owner)
        self.assertIn("eligible jurisdiction", owner)

    def test_ids_are_unique(self) -> None:
        ids = [f.id for f in FORM.fields if f.id]
        self.assertEqual(len(ids), len(set(ids)))


class CompleteDocumentTest(unittest.TestCase):
    def test_a_complete_pack_has_no_problem(self) -> None:
        self.assertEqual(problems(document()), [])

    def test_update_writes_the_count_lines_it_checks(self) -> None:
        text = document()
        stale = text.replace("Tags: 3 / 25", "Tags: 1 / 25").replace("Scale: 1 to 10", "Scale: 0 to 9")
        self.assertNotEqual(problems(stale), [])
        self.assertEqual(sf.updated(stale, FORM), text)


class TextTest(unittest.TestCase):
    def test_pitch_over_200_characters(self) -> None:
        pitch = "PayPal and the AI " + "x" * 183
        self.assertEqual(len(pitch), 201)
        found = problems(document(bodies={"paypal.pitch": pitch}))
        self.assertIn("paypal.md: paypal.pitch has 201 characters, over its limit of 200", found)
        self.assertEqual(problems(document(bodies={"paypal.pitch": pitch[:200]})), [])

    def test_name_over_60_characters(self) -> None:
        found = problems(document(bodies={"paypal.name": "P" * 61}))
        self.assertIn("paypal.md: paypal.name has 61 characters, over its limit of 60", found)

    def test_a_marker_cannot_change_the_forms_limit(self) -> None:
        found = problems(document(kinds={"paypal.pitch": "max=250"}))
        self.assertIn("paypal.md: paypal.pitch is marked max=250; in the PayPal AI Hackathon's Devpost form it is max=200", found)

    def test_pitch_and_story_name_paypal_and_the_ai(self) -> None:
        found = problems(document(bodies={"paypal.pitch": "One invoice, two rails.", "paypal.story": "Built on PayPal."}))
        self.assertIn("paypal.md: paypal.pitch does not name PayPal", found)
        self.assertIn("paypal.md: paypal.pitch does not name the AI", found)
        self.assertIn("paypal.md: paypal.story does not name the AI", found)
        self.assertNotIn("paypal.md: paypal.story does not name PayPal", found)

    def test_characters_are_code_points(self) -> None:
        field = sf.Field("x", "max=10", "Tonga ve? ·", "")
        self.assertEqual(sf.count_line(field), "Characters: 11 / 10")
        self.assertEqual(sf.count_line(sf.Field("x", "max=0", "a" * 1234, "")), "Characters: 1,234 (no stated limit)")


class TagsTest(unittest.TestCase):
    def tags(self, n: int) -> str:
        return "\n".join(["paypal", "cloudflare-workers-ai", *[f"tag-{i}" for i in range(n - 2)]])

    def test_25_tags_pass_and_26_fail(self) -> None:
        self.assertEqual(problems(document(bodies={"paypal.built-with": self.tags(25)})), [])
        found = problems(document(bodies={"paypal.built-with": self.tags(26)}))
        self.assertIn("paypal.md: paypal.built-with has 26 tags, over the form's 25", found)

    def test_a_tag_twice_or_empty(self) -> None:
        found = problems(document(bodies={"paypal.built-with": "paypal\ncloudflare-workers-ai\nPayPal"}))
        self.assertIn("paypal.md: paypal.built-with repeats the tag 'PayPal'", found)
        found = problems(document(bodies={"paypal.built-with": "paypal\n\ncloudflare-workers-ai"}))
        self.assertIn("paypal.md: paypal.built-with has an empty tag or a tag with spaces around it (one tag per line)", found)

    def test_tags_name_paypal_and_the_ai(self) -> None:
        found = problems(document(bodies={"paypal.built-with": "typescript\nhono"}))
        self.assertIn("paypal.md: paypal.built-with does not name PayPal (a tag starting with paypal)", found)
        self.assertIn("paypal.md: paypal.built-with does not name the AI (a tag ai, or ending in -ai)", found)
        self.assertEqual(problems(document(bodies={"paypal.built-with": "paypal-invoicing\nai"})), [])
        found = problems(document(bodies={"paypal.built-with": "paypal\nemail"}))
        self.assertIn("paypal.md: paypal.built-with does not name the AI (a tag ai, or ending in -ai)", found)


class ChoiceTest(unittest.TestCase):
    def test_one_of_the_forms_options(self) -> None:
        found = problems(document(bodies={"paypal.submitter-type": "Solo"}))
        self.assertIn("paypal.md: paypal.submitter-type answers 'Solo', which is not one of the form's options", found)
        self.assertEqual(problems(document(bodies={"paypal.new-or-existing": "Existing"})), [])

    def test_the_count_line_lists_the_options(self) -> None:
        self.assertIn("One of: Individual · Team · Organization", document())
        self.assertIn("Any of: AG Grid · APIMatic · Astropods", document())

    def test_several_options(self) -> None:
        self.assertEqual(problems(document(bodies={"paypal.sponsor-tools": "Postman\nRender"})), [])
        found = problems(document(bodies={"paypal.sponsor-tools": "None, used other AI tools.\nPostman"}))
        self.assertIn("paypal.md: paypal.sponsor-tools picks 'None' together with another option", found)
        found = problems(document(bodies={"paypal.sponsor-tools": "Postman\nPostman"}))
        self.assertIn("paypal.md: paypal.sponsor-tools picks an option twice", found)
        found = problems(document(bodies={"paypal.sponsor-tools": "Anthropic"}))
        self.assertIn("paypal.md: paypal.sponsor-tools picks 'Anthropic', which is not one of the form's options", found)

    def test_scale(self) -> None:
        self.assertEqual(problems(document(bodies={"paypal.rating": "8"})), [])
        for answer in ("0", "11", "8.5", "eight"):
            found = problems(document(bodies={"paypal.rating": answer}))
            self.assertIn(f"paypal.md: paypal.rating answers '{answer}', not a whole number from 1 to 10", found)

    def test_a_document_without_a_form_has_no_choices(self) -> None:
        text = "\n".join(block("monad.kind", "choice", "New", None)) + "\n"
        self.assertEqual(sf.problems_in("monad.md", text, None), ["monad.md: monad.kind is a choice field, which needs its form in FORMS"])


class AddressTest(unittest.TestCase):
    def test_url(self) -> None:
        found = problems(document(bodies={"paypal.demo": "http://example.org/"}))
        self.assertIn("paypal.md: paypal.demo is not one https address", found)
        found = problems(document(bodies={"paypal.repository": "https://example.org/a https://example.org/b"}))
        self.assertIn("paypal.md: paypal.repository is not one https address", found)

    def test_links(self) -> None:
        found = problems(document(bodies={"paypal.try-it": "https://example.org/\nsee the repository"}))
        self.assertIn("paypal.md: paypal.try-it has 'see the repository', not an https address on a line of its own", found)

    def test_select_is_one_line(self) -> None:
        found = problems(document(bodies={"paypal.country": "Madagascar\nFrance"}))
        self.assertIn("paypal.md: paypal.country is not one line", found)


class FormCoverageTest(unittest.TestCase):
    def test_a_required_field_left_out(self) -> None:
        found = problems(document(drop=frozenset({"paypal.ai-tools"})))
        self.assertIn(
            'paypal.md: the required field "Which AI tools have you leveraged while working on this project?" (paypal.ai-tools) is missing', found
        )

    def test_an_optional_field_may_be_left_out(self) -> None:
        self.assertEqual(problems(document(drop=frozenset({"paypal.testing", "paypal.try-it"}))), [])

    def test_every_field_is_named_even_those_the_owner_fills(self) -> None:
        found = problems(document(unnamed=frozenset({"Demo video", "eligible jurisdiction"})))
        self.assertIn('paypal.md: the form\'s field "Demo video" (filled by the owner) is not named in the document', found)
        self.assertIn('paypal.md: the form\'s field "eligible jurisdiction" (filled by the owner) is not named in the document', found)

    def test_a_field_the_form_does_not_have(self) -> None:
        found = problems(document(extra=block("paypal.updates", "max=0", "What changed.", None)))
        self.assertIn("paypal.md: paypal.updates is not a field of the PayPal AI Hackathon's Devpost form", found)

    def test_the_forms_order(self) -> None:
        found = problems(document(order=["paypal.pitch", "paypal.name"]))
        self.assertTrue(any("not in the order of the PayPal AI Hackathon's Devpost form" in p for p in found), found)

    def test_a_field_twice(self) -> None:
        found = problems(document(extra=block("paypal.name", "max=60", "PayLink Twin", BY_ID["paypal.name"])))
        self.assertIn("paypal.md: field paypal.name appears twice", found)

    def test_a_marker_without_its_count_line(self) -> None:
        text = document(bodies={"paypal.name": "PayLink Twin"})
        self.assertIn("Characters: 12 / 60", text)
        found = problems(text.replace("Characters: 12 / 60", "", 1))
        self.assertTrue(any("well-formed fields" in p for p in found), found)


class CommittedPacksTest(unittest.TestCase):
    """Every pack in docs/submissions passes, and the PayPal pack answers its form as the owner did on 2026-10-29."""

    def test_every_pack_passes(self) -> None:
        for path in sf.documents():
            with self.subTest(path=path.name):
                self.assertEqual(sf.problems(path), [])

    def test_the_paypal_pack_holds_the_owners_answers(self) -> None:
        path = sf.SUBMISSIONS / "paypal.md"
        answers = {field.id: field.body for field in sf.fields(path)}
        self.assertEqual(answers["paypal.submitter-type"], "Individual")
        self.assertEqual(answers["paypal.country"], "Madagascar")
        self.assertEqual(answers["paypal.province"], "N/A")
        self.assertEqual(answers["paypal.organization"], "N/A")
        self.assertEqual(answers["paypal.new-or-existing"], "Existing")
        self.assertEqual(answers["paypal.sponsor-tools"], "None, used other AI tools.")
        self.assertEqual(answers["paypal.rating"], "8")
        self.assertEqual(answers["paypal.contact"], "Yes")
        self.assertEqual(answers["paypal.learning"], "Significant")
        self.assertEqual(answers["paypal.ai-value"], "Yes")
        self.assertEqual(
            answers["paypal.ai-tools"],
            "Claude Code (Anthropic) as the project's AI assistant (code, tests, documentation) under my direction; inside the "
            "product, Cloudflare Workers AI (Google Gemma model) for the drafting assistant and the desk agent.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=1)
