#!/usr/bin/env python3
"""Build the static daily paper feed from official arXiv listings and Atom metadata."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import html.parser
import json
import math
import os
import re
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable, Sequence

DEFAULT_CATEGORIES = ("astro-ph.CO", "gr-qc", "hep-ph", "hep-th")
LISTING_URL = "https://arxiv.org/list/{category}/new"
API_URL = "https://export.arxiv.org/api/query"
USER_AGENT = "SergioPaperFeed/1.0 (https://github.com/SergioSevi/hugo-demo2)"
REQUEST_INTERVAL_SECONDS = 3.1
ATOM_NS = "http://www.w3.org/2005/Atom"
ARXIV_NS = "http://arxiv.org/schemas/atom"
ARXIV_ID_RE = re.compile(r"(?:https?://(?:export\.)?arxiv\.org)?/abs/([^?#]+)", re.I)
VERSION_RE = re.compile(r"v\d+$", re.I)
SPACE_RE = re.compile(r"\s+")
LATEX_COMMAND_RE = re.compile(r"\\[A-Za-z]+\*?(?:\[[^\]]*\])?")
TOKEN_RE = re.compile(r"[a-z][a-z0-9-]{2,}")

STOPWORDS = {
    "about", "above", "across", "after", "again", "against", "allow", "allows",
    "also", "among", "analysis", "another", "approach", "around", "based", "because",
    "been", "before", "being", "below", "between", "both", "can", "could", "data",
    "describe", "different", "does", "during", "each", "effect", "effects", "either",
    "first", "following", "found", "framework", "from", "further", "general", "given",
    "have", "having", "here", "high", "however", "including", "into", "investigate",
    "large", "leading", "make", "many", "method", "model", "models", "more", "most",
    "new", "novel", "observations", "obtain", "other", "over", "paper", "present",
    "properties", "provide", "range", "result", "results", "scale", "scales", "show",
    "shown", "shows", "since", "some", "study", "such", "system", "than", "that",
    "their", "them", "then", "theory", "there", "these", "they", "this", "those",
    "through", "toward", "towards", "under", "using", "various", "very", "which",
    "while", "with", "within", "without", "would"
}


def collapse_space(value: str | None) -> str:
    return SPACE_RE.sub(" ", value or "").strip()


def normalize_arxiv_id(value: str) -> str:
    value = value.strip().replace("arXiv:", "")
    value = VERSION_RE.sub("", value)
    return value


def category_filename(category: str) -> str:
    return category.replace("/", "_") + ".html"


class ListingParser(html.parser.HTMLParser):
    """Extract the release date plus new and cross-listed IDs from an arXiv list page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.release_date = ""
        self.new_ids: list[str] = []
        self.cross_ids: list[str] = []
        self._heading_depth = 0
        self._heading_parts: list[str] = []
        self._current_section = ""
        self._dt_depth = 0
        self._dt_had_id = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "h3":
            self._heading_depth = 1
            self._heading_parts = []
            return
        if self._heading_depth:
            self._heading_depth += 1

        if tag == "dt":
            self._dt_depth += 1
            if self._dt_depth == 1:
                self._dt_had_id = False
            return

        if tag != "a" or not self._dt_depth or self._dt_had_id:
            return
        href = dict(attrs).get("href") or ""
        match = ARXIV_ID_RE.search(href)
        if not match:
            return
        arxiv_id = normalize_arxiv_id(match.group(1))
        if not arxiv_id:
            return
        if self._current_section == "new":
            self.new_ids.append(arxiv_id)
            self._dt_had_id = True
        elif self._current_section == "cross":
            self.cross_ids.append(arxiv_id)
            self._dt_had_id = True

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "h3" and self._heading_depth:
            heading = collapse_space("".join(self._heading_parts))
            lower = heading.lower()
            if lower.startswith("showing new listings for"):
                self.release_date = heading[len("Showing new listings for") :].strip()
            elif lower.startswith("new submissions"):
                self._current_section = "new"
            elif lower.startswith("cross submissions") or lower.startswith("cross-lists"):
                self._current_section = "cross"
            elif lower.startswith("replacement submissions") or lower.startswith("replacements"):
                self._current_section = "replacement"
            self._heading_depth = 0
            self._heading_parts = []
            return
        if self._heading_depth:
            self._heading_depth -= 1

        if tag == "dt" and self._dt_depth:
            self._dt_depth -= 1
            if not self._dt_depth:
                self._dt_had_id = False

    def handle_data(self, data: str) -> None:
        if self._heading_depth:
            self._heading_parts.append(data)


def deduplicate(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def parse_listing_html(document: str) -> dict[str, object]:
    parser = ListingParser()
    parser.feed(document)
    parser.close()
    return {
        "release_date": parser.release_date,
        "new_ids": deduplicate(parser.new_ids),
        "cross_ids": deduplicate(parser.cross_ids),
    }


class PoliteFetcher:
    def __init__(self, interval: float = REQUEST_INTERVAL_SECONDS) -> None:
        self.interval = max(0.0, interval)
        self._last_request = 0.0

    def _wait(self) -> None:
        elapsed = time.monotonic() - self._last_request
        remaining = self.interval - elapsed
        if remaining > 0:
            time.sleep(remaining)

    def fetch(self, url: str, attempts: int = 4) -> bytes:
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            self._wait()
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/atom+xml, application/xml, text/html;q=0.9, */*;q=0.1",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=45) as response:
                    payload = response.read()
                    self._last_request = time.monotonic()
                    return payload
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as error:
                self._last_request = time.monotonic()
                last_error = error
                if attempt == attempts:
                    break
                time.sleep(min(2 ** attempt, 12))
        raise RuntimeError(f"Could not fetch {url}: {last_error}")


def parse_atom_feed(document: bytes | str) -> dict[str, dict[str, object]]:
    root = ET.fromstring(document)
    records: dict[str, dict[str, object]] = {}
    atom = f"{{{ATOM_NS}}}"
    arxiv = f"{{{ARXIV_NS}}}"

    for entry in root.findall(f"{atom}entry"):
        entry_url = collapse_space(entry.findtext(f"{atom}id"))
        match = ARXIV_ID_RE.search(entry_url)
        if not match:
            continue
        arxiv_id = normalize_arxiv_id(match.group(1))
        authors = [
            collapse_space(author.findtext(f"{atom}name"))
            for author in entry.findall(f"{atom}author")
        ]
        authors = [author for author in authors if author]
        categories = deduplicate([
            collapse_space(category.attrib.get("term"))
            for category in entry.findall(f"{atom}category")
            if collapse_space(category.attrib.get("term"))
        ])
        primary_element = entry.find(f"{arxiv}primary_category")
        primary_category = collapse_space(primary_element.attrib.get("term")) if primary_element is not None else ""

        alternate_url = f"https://arxiv.org/abs/{arxiv_id}"
        pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
        for link in entry.findall(f"{atom}link"):
            href = collapse_space(link.attrib.get("href"))
            rel = collapse_space(link.attrib.get("rel"))
            title = collapse_space(link.attrib.get("title"))
            link_type = collapse_space(link.attrib.get("type"))
            if href and rel == "alternate":
                alternate_url = href.replace("http://", "https://", 1)
            if href and (title == "pdf" or link_type == "application/pdf"):
                pdf_url = href.replace("http://", "https://", 1)

        records[arxiv_id] = {
            "id": arxiv_id,
            "title": collapse_space(entry.findtext(f"{atom}title")),
            "authors": authors,
            "summary": collapse_space(entry.findtext(f"{atom}summary")),
            "published": collapse_space(entry.findtext(f"{atom}published")),
            "updated": collapse_space(entry.findtext(f"{atom}updated")),
            "primary_category": primary_category,
            "categories": categories,
            "url": alternate_url,
            "pdf_url": pdf_url,
        }
    return records


def normalize_feature_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode("ascii")
    value = LATEX_COMMAND_RE.sub(" ", value)
    value = value.replace("{", " ").replace("}", " ")
    value = value.lower().replace("--", "-")
    return collapse_space(value)


def feature_tokens(value: str) -> list[str]:
    return [token for token in TOKEN_RE.findall(normalize_feature_text(value)) if token not in STOPWORDS]


def add_weighted_terms(counter: collections.Counter[str], tokens: Sequence[str], unigram: float, bigram: float) -> None:
    token_counts = collections.Counter(tokens)
    for token, count in token_counts.items():
        counter[token] += unigram * min(count, 3)
    bigram_counts = collections.Counter(f"{tokens[index]} {tokens[index + 1]}" for index in range(len(tokens) - 1))
    for phrase, count in bigram_counts.items():
        counter[phrase] += bigram * min(count, 2)


def extract_topic_features(title: str, summary: str, limit: int = 36) -> list[dict[str, object]]:
    weights: collections.Counter[str] = collections.Counter()
    add_weighted_terms(weights, feature_tokens(title), unigram=2.0, bigram=3.2)
    add_weighted_terms(weights, feature_tokens(summary), unigram=0.28, bigram=0.42)
    ordered = sorted(weights.items(), key=lambda item: (-item[1], item[0]))[:limit]
    return [
        {"term": term, "weight": round(float(weight), 4)}
        for term, weight in ordered
        if math.isfinite(weight) and weight > 0
    ]


def chunks(values: Sequence[str], size: int) -> Iterable[Sequence[str]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def fetch_metadata(ids: Sequence[str], fetcher: PoliteFetcher) -> dict[str, dict[str, object]]:
    records: dict[str, dict[str, object]] = {}
    for batch in chunks(ids, 40):
        query = urllib.parse.urlencode({
            "id_list": ",".join(batch),
            "start": 0,
            "max_results": len(batch),
        })
        payload = fetcher.fetch(f"{API_URL}?{query}")
        records.update(parse_atom_feed(payload))
    return records


def build_feed(
    categories: Sequence[str],
    listing_documents: dict[str, str],
    metadata: dict[str, dict[str, object]],
) -> dict[str, object]:
    appearances: dict[str, dict[str, object]] = {}
    release_dates: list[str] = []
    sequence = 0

    for category in categories:
        listing = parse_listing_html(listing_documents[category])
        release_date = str(listing.get("release_date") or "")
        if release_date:
            release_dates.append(release_date)

        for listing_type, key in (("new", "new_ids"), ("cross", "cross_ids")):
            for arxiv_id in listing[key]:
                if arxiv_id not in appearances:
                    appearances[arxiv_id] = {
                        "new_in": [],
                        "cross_in": [],
                        "listing_order": sequence,
                    }
                    sequence += 1
                destination = "new_in" if listing_type == "new" else "cross_in"
                if category not in appearances[arxiv_id][destination]:
                    appearances[arxiv_id][destination].append(category)

    missing = [arxiv_id for arxiv_id in appearances if arxiv_id not in metadata]
    if missing:
        preview = ", ".join(missing[:8])
        raise RuntimeError(f"The arXiv API did not return metadata for {len(missing)} listed papers: {preview}")

    papers: list[dict[str, object]] = []
    for arxiv_id, appearance in appearances.items():
        record = dict(metadata[arxiv_id])
        new_in = list(appearance["new_in"])
        cross_in = list(appearance["cross_in"])
        source_categories = [category for category in categories if category in set(new_in + cross_in)]
        record.update({
            "listing_type": "new" if new_in else "cross",
            "source_categories": source_categories,
            "new_in": new_in,
            "cross_in": cross_in,
            "listing_order": int(appearance["listing_order"]),
            "features": {
                "topics": extract_topic_features(
                    str(record.get("title") or ""),
                    str(record.get("summary") or ""),
                )
            },
        })
        papers.append(record)

    papers.sort(key=lambda paper: int(paper.get("listing_order", 0)))
    release_date = collections.Counter(release_dates).most_common(1)[0][0] if release_dates else "Latest release"
    return {
        "schema_version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "release_date": release_date,
        "sample": False,
        "categories": list(categories),
        "papers": papers,
    }


def validate_feed(feed: dict[str, object]) -> None:
    if feed.get("schema_version") != 1:
        raise ValueError("Unsupported feed schema")
    papers = feed.get("papers")
    if not isinstance(papers, list):
        raise ValueError("Feed papers must be a list")
    seen: set[str] = set()
    for paper in papers:
        if not isinstance(paper, dict):
            raise ValueError("Every paper must be an object")
        arxiv_id = str(paper.get("id") or "")
        if not arxiv_id or arxiv_id in seen:
            raise ValueError(f"Missing or duplicate paper id: {arxiv_id!r}")
        seen.add(arxiv_id)
        if not str(paper.get("title") or "").strip():
            raise ValueError(f"Paper {arxiv_id} has no title")
        if paper.get("listing_type") not in {"new", "cross"}:
            raise ValueError(f"Paper {arxiv_id} has an invalid listing type")


def atomic_write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(text)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def load_fixture_metadata(path: Path) -> dict[str, dict[str, object]]:
    return parse_atom_feed(path.read_bytes())


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--categories",
        nargs="+",
        default=list(DEFAULT_CATEGORIES),
        help="arXiv category codes to include",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("static/cosmos-briefing-7f3c91/data/papers.json"),
        help="destination JSON file",
    )
    parser.add_argument(
        "--fixture-dir",
        type=Path,
        help="offline fixture directory containing category HTML files and atom.xml",
    )
    parser.add_argument(
        "--no-delay",
        action="store_true",
        help="disable the request interval, intended only for tests",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    categories = tuple(args.categories)
    if not categories:
        raise ValueError("At least one category is required")

    if args.fixture_dir:
        listing_documents = {
            category: (args.fixture_dir / category_filename(category)).read_text(encoding="utf-8")
            for category in categories
        }
        metadata = load_fixture_metadata(args.fixture_dir / "atom.xml")
    else:
        fetcher = PoliteFetcher(0.0 if args.no_delay else REQUEST_INTERVAL_SECONDS)
        listing_documents = {}
        for category in categories:
            print(f"Fetching {category} listing", flush=True)
            listing_documents[category] = fetcher.fetch(
                LISTING_URL.format(category=urllib.parse.quote(category, safe=".-"))
            ).decode("utf-8", errors="replace")

        all_ids: list[str] = []
        for category in categories:
            listing = parse_listing_html(listing_documents[category])
            all_ids.extend(listing["new_ids"])
            all_ids.extend(listing["cross_ids"])
        all_ids = deduplicate(all_ids)
        print(f"Fetching metadata for {len(all_ids)} papers", flush=True)
        metadata = fetch_metadata(all_ids, fetcher) if all_ids else {}

    feed = build_feed(categories, listing_documents, metadata)
    validate_feed(feed)
    atomic_write_json(args.output, feed)
    print(f"Wrote {len(feed['papers'])} papers to {args.output}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Paper feed update failed: {error}", file=sys.stderr)
        raise
