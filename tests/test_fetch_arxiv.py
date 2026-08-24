import json
import tempfile
import unittest
from pathlib import Path

from scripts.fetch_arxiv import (
    DEFAULT_CATEGORIES,
    build_feed,
    extract_topic_features,
    main,
    parse_atom_feed,
    parse_listing_html,
)


FIXTURES = Path(__file__).parent / "fixtures"


class ListingParserTests(unittest.TestCase):
    def test_extracts_new_and_cross_ids_but_not_replacements(self):
        parsed = parse_listing_html((FIXTURES / "astro-ph.CO.html").read_text())
        self.assertEqual(parsed["release_date"], "Monday, 24 August 2026")
        self.assertEqual(parsed["new_ids"], ["2608.00001"])
        self.assertEqual(parsed["cross_ids"], ["2608.00002"])
        self.assertNotIn("2501.99999", parsed["new_ids"] + parsed["cross_ids"])

    def test_atom_parser_preserves_unicode_and_strips_versions(self):
        metadata = parse_atom_feed((FIXTURES / "atom.xml").read_bytes())
        self.assertIn("2608.00001", metadata)
        self.assertEqual(metadata["2608.00001"]["primary_category"], "astro-ph.CO")
        self.assertTrue(metadata["2608.00001"]["url"].startswith("https://"))


class FeedBuilderTests(unittest.TestCase):
    def setUp(self):
        self.documents = {
            category: (FIXTURES / f"{category}.html").read_text()
            for category in DEFAULT_CATEGORIES
        }
        self.metadata = parse_atom_feed((FIXTURES / "atom.xml").read_bytes())

    def test_global_new_submission_overrides_cross_listing(self):
        feed = build_feed(DEFAULT_CATEGORIES, self.documents, self.metadata)
        by_id = {paper["id"]: paper for paper in feed["papers"]}
        self.assertEqual(by_id["2608.00001"]["listing_type"], "new")
        self.assertEqual(by_id["2608.00002"]["listing_type"], "new")
        self.assertEqual(by_id["2608.00003"]["listing_type"], "cross")
        self.assertEqual(by_id["2608.00001"]["source_categories"], ["astro-ph.CO", "gr-qc"])
        self.assertEqual(len(feed["papers"]), 4)

    def test_topic_features_include_scientific_phrases(self):
        features = extract_topic_features(
            "Dark energy and modified gravity",
            "We study scalar tensor dark energy and fifth forces.",
        )
        terms = {item["term"] for item in features}
        self.assertIn("dark energy", terms)
        self.assertIn("modified gravity", terms)

    def test_fixture_cli_writes_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "papers.json"
            exit_code = main([
                "--fixture-dir", str(FIXTURES),
                "--output", str(output),
            ])
            self.assertEqual(exit_code, 0)
            payload = json.loads(output.read_text())
            self.assertFalse(payload["sample"])
            self.assertEqual(len(payload["papers"]), 4)


if __name__ == "__main__":
    unittest.main()
