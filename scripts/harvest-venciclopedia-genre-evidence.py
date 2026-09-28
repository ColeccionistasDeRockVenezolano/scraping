#!/usr/bin/env python3
"""Read explicit genre fields from Venciclopedia's public MediaWiki API.

This is a read-only evidence harvest. It never writes catalog genre claims.
The site requests a ten-second crawl delay, enforced between API calls.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
DATA = ROOT / "data"
INVENTORY = REPORTS / "genre-laya-evidence-coverage-2026-09-26-inventory.jsonl"
PROGRESS = REPORTS / "genre-laya-evidence-progress-2026-09-26.json"
LEDGER = REPORTS / "genre-laya-evidence-venciclopedia-2026-09-26.jsonl"
REJECTIONS = REPORTS / "genre-laya-evidence-venciclopedia-rejected-2026-09-26.jsonl"
STATE = REPORTS / "genre-laya-evidence-venciclopedia-state-2026-09-26.json"
RAW_DIR = DATA / "raw" / "venciclopedia"
API = "https://www.venciclopedia.org/api.php"
SITE = "https://www.venciclopedia.org/"
DELAY_SECONDS = 10.2  # robots.txt: Crawl-delay: 10
MAX_TITLES = 45  # stay below MediaWiki's normal anonymous limit of 50


def read_contact() -> str:
    value = os.environ.get("GENRES_EXTERNAL_CONTACT", "").strip()
    if value:
        return value
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("GENRES_EXTERNAL_CONTACT="):
                return line.split("=", 1)[1].strip().strip("\"'")
    return "genre-curation contact configured in CRV"


def normalized(text: str) -> str:
    import unicodedata
    value = unicodedata.normalize("NFKD", text.casefold())
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def clean_markup(value: str) -> str:
    value = re.sub(r"<!--.*?-->", "", value, flags=re.S)
    value = re.sub(r"<ref\b[^>]*>.*?</ref\s*>", "", value, flags=re.I | re.S)
    value = re.sub(r"<ref\b[^>]*/\s*>", "", value, flags=re.I)
    value = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", value)
    value = re.sub(r"\[\[([^\]]+)\]\]", r"\1", value)
    value = re.sub(r"\[https?://[^ ]+ ([^\]]+)\]", r"\1", value)
    value = re.sub(r"\{\{(?:csv|lista|flatlist)\s*\|", "", value, flags=re.I)
    value = value.replace("}}", "")
    value = re.sub(r"'''?", "", value)
    value = re.sub(r"<[^>]+>", " ", value)
    value = value.replace("&nbsp;", " ").replace("&#160;", " ")
    return re.sub(r"\s+", " ", value).strip(" |;,\t\r\n")


def template_parameters(wikitext: str) -> list[tuple[str, str]]:
    """Read template parameters without mistaking nested CSV pipes for fields."""
    result: list[tuple[str, str]] = []
    depth = 0
    field_start: int | None = None
    i = 0
    while i < len(wikitext) - 1:
        pair = wikitext[i:i + 2]
        if pair == "{{":
            depth += 1
            i += 2
            continue
        if pair == "}}" and depth:
            if depth == 1 and field_start is not None:
                segment = wikitext[field_start:i].strip()
                if "=" in segment:
                    key, value = segment.split("=", 1)
                    result.append((key.strip(), value.strip()))
                field_start = None
            depth -= 1
            i += 2
            continue
        if pair[0] == "|" and depth == 1:
            if field_start is not None:
                segment = wikitext[field_start:i].strip()
                if "=" in segment:
                    key, value = segment.split("=", 1)
                    result.append((key.strip(), value.strip()))
            field_start = i + 1
        i += 1
    return result


def fields(wikitext: str) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for raw_key, raw_value in template_parameters(wikitext):
        key = normalized(raw_key).replace(" ", "")
        if key in {"genero", "genero1", "genero2", "genero3", "genero4"}:
            value = clean_markup(raw_value)
            if value:
                found.setdefault("genres", []).extend(
                    [part.strip() for part in re.split(r"\s*[,;/|]\s*", value) if part.strip()]
                )
        if key in {"artista", "artistas", "artist"}:
            value = clean_markup(raw_value)
            if value:
                found.setdefault("artist", []).extend(
                    [part.strip() for part in value.split("|") if part.strip() and "=" not in part]
                )
        if key in {"ano", "anio", "fecha", "year"}:
            value = clean_markup(raw_value)
            if value:
                found.setdefault("year", []).append(value)
        if key in {"tipo", "tipoartista", "tipoentidad"}:
            value = clean_markup(raw_value)
            if value:
                found.setdefault("type", []).append(value)
        if key in {"origen", "pais", "nacionalidad", "ubicacion", "ciudad"}:
            value = clean_markup(raw_value)
            if value:
                found.setdefault("origin", []).append(value)
    found["genres"] = list(dict.fromkeys(found.get("genres", [])))
    return found


def year_from(values: list[str]) -> int | None:
    for value in values:
        match = re.search(r"\b(19|20)\d{2}\b", value)
        if match:
            return int(match.group(0))
    return None


def has_venezuela_signal(wikitext: str, extracted: dict[str, list[str]]) -> bool:
    source = " ".join(extracted.get("origin", [])) + " " + wikitext[:2500]
    return bool(re.search(r"\b(venezuel[oa]|Venezuela|Caracas|Maracaibo|Valencia|Barquisimeto|Maracay|Mérida|Merida|Puerto Ordaz|San Cristóbal|San Cristobal|Cabimas|Punto Fijo)\b", source, re.I))


def get_content(page: dict[str, Any]) -> str:
    revisions = page.get("revisions") or []
    if not revisions:
        return ""
    revision = revisions[0]
    slot = revision.get("slots", {}).get("main", {})
    return slot.get("content") or slot.get("*") or ""


def get_contact_ua() -> str:
    return f"CRV-generos/1.0 ({read_contact()})"


class ApiClient:
    def __init__(self) -> None:
        self.last_request = 0.0
        self.ua = get_contact_ua()
        self.requests = 0

    def query(self, titles: list[str]) -> dict[str, Any]:
        wait = DELAY_SECONDS - (time.monotonic() - self.last_request)
        if self.last_request and wait > 0:
            time.sleep(wait)
        params = {
            "action": "query", "prop": "revisions|info", "rvprop": "ids|timestamp|content",
            "rvslots": "main", "inprop": "url", "redirects": "1", "format": "json",
            "formatversion": "2", "maxlag": "5", "titles": "|".join(titles),
        }
        url = API + "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, headers={"User-Agent": self.ua, "Accept": "application/json"})
        self.last_request = time.monotonic()
        self.requests += 1
        with urllib.request.urlopen(request, timeout=40) as response:
            payload = json.load(response)
        if "error" in payload:
            raise RuntimeError(f"MediaWiki API: {payload['error']}")
        return payload


def snapshot_for(row: dict[str, Any], page: dict[str, Any], extracted: dict[str, list[str]],
                 wikitext: str, requested_title: str) -> dict[str, Any]:
    revision = (page.get("revisions") or [{}])[0]
    revision_id = revision.get("revid")
    url = page.get("fullurl") or SITE + "index.php?title=" + urllib.parse.quote(page["title"].replace(" ", "_"))
    if revision_id:
        url += "&oldid=" + str(revision_id)
    record = {
        "caseId": row["caseId"], "kind": row["kind"], "entityId": row["entityId"],
        "requestedTitle": requested_title, "pageTitle": page["title"], "pageId": page.get("pageid"),
        "revisionId": revision_id, "revisionTimestamp": revision.get("timestamp"), "url": url,
        "genres": extracted.get("genres", []), "artist": extracted.get("artist", []),
        "year": extracted.get("year", []), "type": extracted.get("type", []),
        "origin": extracted.get("origin", []), "wikitextSha256": hashlib.sha256(wikitext.encode()).hexdigest(),
        "attribution": "La Venciclopedia (GFDL): " + url,
    }
    body = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    digest = hashlib.sha256(body).hexdigest()
    snap_name = digest + ".json"
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    (RAW_DIR / snap_name).write_bytes(body + b"\n")
    return {**record, "snapshot": "raw/venciclopedia/" + snap_name, "snapshotSha256": digest}


def matches(row: dict[str, Any], page: dict[str, Any], extracted: dict[str, list[str]],
            wikitext: str, requested_title: str) -> tuple[bool, str]:
    if page.get("missing") is not None:
        return False, "missing_page"
    page_title = normalized(page.get("title", ""))
    expected_title = normalized(row.get("title", ""))
    if page_title not in {expected_title, normalized(row.get("title", "") + " (disco)")} :
        return False, "title_mismatch"
    if not extracted.get("genres"):
        return False, "no_explicit_genre_field"
    if row["kind"] == "artist":
        if not has_venezuela_signal(wikitext, extracted):
            return False, "artist_identity_not_corroborated_as_venezuelan"
        return True, ""
    expected_artist = normalized(row.get("artistName") or "")
    source_artists = [normalized(value) for value in extracted.get("artist", [])]
    if not expected_artist or not source_artists:
        return False, "album_artist_missing"
    if not any(expected_artist == value or expected_artist in value or value in expected_artist
               for value in source_artists):
        return False, "album_artist_mismatch"
    expected_year = row.get("year")
    source_year = year_from(extracted.get("year", []))
    if expected_year and source_year and abs(int(expected_year) - source_year) > 1:
        return False, "album_year_mismatch"
    return True, ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="maximum cases per level; 0 means all remaining")
    parser.add_argument("--kind", choices=["artist", "album", "both"], default="both")
    parser.add_argument("--popular", action="store_true", help="prioritize radio and highly played cases")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    inventory = [json.loads(line) for line in INVENTORY.read_text(encoding="utf-8").splitlines() if line]
    if len(inventory) != 4128 or len({row["caseId"] for row in inventory}) != 4128:
        raise RuntimeError("fixed inventory must contain 4,128 unique cases")
    pending = set(json.loads(PROGRESS.read_text(encoding="utf-8"))["remainingIds"])
    existing = set()
    if args.resume and LEDGER.exists():
        existing = {json.loads(line)["caseId"] for line in LEDGER.read_text(encoding="utf-8").splitlines() if line}
    targets = [row for row in inventory if row["caseId"] in pending and row["caseId"] not in existing
               and (args.kind == "both" or row["kind"] == args.kind)]
    if args.popular:
        targets.sort(key=lambda row: (not row.get("radio", False), -row.get("trackCount", 0), row["entityId"]))
    if args.limit:
        by_kind = {kind: [row for row in targets if row["kind"] == kind][:args.limit] for kind in ("artist", "album")}
        targets = [row for kind in ("artist", "album") for row in by_kind[kind]]

    # Ask for an album's plain title and its common disambiguated article title.
    lookup: dict[str, list[dict[str, Any]]] = {}
    for row in targets:
        title = row["title"].strip()
        choices = [title] if row["kind"] == "artist" else [title, title + " (disco)"]
        for choice in choices:
            lookup.setdefault(choice, []).append(row)
    titles = list(lookup)
    client = ApiClient()
    accepted: dict[str, list[dict[str, Any]]] = {}
    rejected: list[dict[str, Any]] = []
    total = len(titles)
    target_ids = [row["caseId"] for row in targets]
    fingerprint = hashlib.sha256(json.dumps({"targetIds": target_ids, "titles": titles}, ensure_ascii=False,
                                             sort_keys=True).encode()).hexdigest()
    processed_titles = 0
    if args.resume and STATE.exists():
        try:
            saved = json.loads(STATE.read_text(encoding="utf-8"))
            if saved.get("fingerprint") == fingerprint:
                accepted = saved.get("accepted", {})
                rejected = saved.get("rejected", [])
                processed_titles = int(saved.get("processedTitles", 0))
                print(json.dumps({"resumeFromTitle": processed_titles, "totalTitles": total}, ensure_ascii=False), flush=True)
        except (ValueError, OSError, TypeError):
            pass
    for start in range(processed_titles, total, MAX_TITLES):
        batch = titles[start:start + MAX_TITLES]
        for attempt in range(5):
            try:
                payload = client.query(batch)
                break
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(min(60, DELAY_SECONDS * (2 ** attempt)))
        normalized_pages = payload.get("query", {}).get("normalized", [])
        redirected = payload.get("query", {}).get("redirects", [])
        request_map = {item["from"]: item["to"] for item in normalized_pages}
        request_map.update({item["from"]: item["to"] for item in redirected})
        pages = payload.get("query", {}).get("pages", [])
        for requested in batch:
            resolved = request_map.get(requested, requested)
            page = next((item for item in pages if normalized(item.get("title", "")) == normalized(resolved)), None)
            if page is None:
                page = {"title": resolved, "missing": "", "revisions": []}
            for row in lookup[requested]:
                wikitext = get_content(page)
                extracted = fields(wikitext)
                ok, reason = matches(row, page, extracted, wikitext, requested)
                if ok:
                    accepted.setdefault(row["caseId"], []).append(snapshot_for(row, page, extracted, wikitext, requested))
                elif reason not in {"missing_page", "no_explicit_genre_field"}:
                    rejected.append({"caseId": row["caseId"], "requestedTitle": requested, "resolvedTitle": page.get("title"), "reason": reason})
        print(json.dumps({"requests": client.requests, "processedTitles": min(start + len(batch), total),
                          "totalTitles": total, "acceptedCases": sum(len(v) > 0 for v in accepted.values()),
                          "pageHits": sum(not p.get("missing") for p in pages)}, ensure_ascii=False), flush=True)
        state = {"fingerprint": fingerprint, "targetIds": target_ids,
                 "processedTitles": min(start + len(batch), total), "accepted": accepted,
                 "rejected": rejected, "requestsThisRun": client.requests}
        STATE.write_text(json.dumps(state, ensure_ascii=False) + "\n", encoding="utf-8")

    ledger_rows = []
    for row in targets:
        matches_for_case = accepted.get(row["caseId"], [])
        if not matches_for_case:
            continue
        genre_sets = {tuple(item["genres"]) for item in matches_for_case}
        if len(genre_sets) != 1:
            rejected.append({"caseId": row["caseId"], "reason": "conflicting_venciclopedia_pages",
                             "pages": [item["url"] for item in matches_for_case]})
            continue
        # Keep all matching same-genre pages as evidence, one ledger row per entity.
        first = matches_for_case[0]
        ledger_rows.append({"caseId": row["caseId"], "kind": row["kind"], "entityId": row["entityId"],
                            "source": "venciclopedia", "rawGenres": first["genres"],
                            "pages": matches_for_case,
                            "identitySignals": ["exact_page_title", "explicit_genre_field"] +
                                (["artist_in_compared_album_record", "artist_match"] if row["kind"] == "album" else ["Venezuela_origin_signal"]),
                            "license": "GFDL", "attribution": "La Venciclopedia"})

    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a", encoding="utf-8") as f:
        for row in ledger_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    with REJECTIONS.open("a", encoding="utf-8") as f:
        for row in rejected:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    STATE.write_text(json.dumps({"fingerprint": fingerprint, "targetIds": target_ids,
                                 "processedTitles": total, "accepted": accepted, "rejected": rejected,
                                 "requestsThisRun": client.requests, "complete": True}, ensure_ascii=False) + "\n",
                     encoding="utf-8")
    print(json.dumps({"targetCases": len(targets), "requestedTitles": total, "requests": client.requests,
                      "accepted": len(ledger_rows), "rejectedIdentityOrConflict": len(rejected),
                      "ledger": str(LEDGER), "license": "GFDL attribution retained"}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"ERROR: {error}", file=sys.stderr)
        raise
