#!/usr/bin/env python3
"""Content-addressed Hankweave docs indexing and scoped queries through the DuckDB CLI."""
# Forgiving this because python is more universally available compared to node. 
# But prefer Typescript - anyone reading this - for an easier life.
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

CACHE_FORMAT = 10  # Optional source coverage and retained missing-source graph identities
DEFAULT_VERSION = "0.10.0"
MISSING_SOURCE = ("Source pack unavailable: attach the matching pack with --source-parquet PATH "
                  "or HANKWEAVE_SOURCE_PARQUET; source bodies are not bundled in the core skill.")
SEARCH_CHARS = 1800
IDENTIFIER = re.compile(r"--[A-Za-z][\w-]*|[A-Za-z_$][\w$]*(?:(?:\?\.|[./:-])[A-Za-z_$][\w$-]*)*")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
LIST_ITEM = re.compile(r"^(\s*)(?:\d+[.)]|[-+*])\s+")
NAVIGATION_TAIL = re.compile(
    r"(?:\A|\n)---\s*\n(?=\*\*(?:Related|Next:)\*\*)"
    r"(?:\*\*Related\*\*\s*\n(?:-\s+\[[^\n]+\]\([^\n]+\)\s*\n)+)?"
    r"(?:\s*\*\*Next:\*\*\s+\[[^\n]+\]\([^\n]+\)\s*)?\s*\Z"
)


def visible_link_text(line):
    """Drop Markdown destinations, retaining labels and literal inline code."""
    result = []
    i = 0
    while i < len(line):
        if line[i] == "\\":
            result.append(line[i:i + 2])
            i += 2
            continue
        if line[i] == "`":
            end = i + 1
            while end < len(line) and line[end] == "`":
                end += 1
            closing = line.find(line[i:end], end)
            if closing >= 0:
                closing += end - i
                result.append(line[i:closing])
                i = closing
                continue
        if line[i] == "<" and re.match(r"<(?:https?://|mailto:)", line[i:]):
            closing = line.find(">", i + 1)
            if closing >= 0:
                i = closing + 1
                continue
        if line[i] == "[":
            end, depth = i + 1, 1
            while end < len(line) and depth:
                if line[end] == "\\":
                    end += 2
                    continue
                depth += (line[end] == "[") - (line[end] == "]")
                end += 1
            if not depth and end < len(line) and line[end] in "([":
                opening = line[end]
                closing = ")" if opening == "(" else "]"
                after, depth = end + 1, 1
                while after < len(line) and depth:
                    if line[after] == "\\":
                        after += 2
                        continue
                    depth += (line[after] == opening) - (line[after] == closing)
                    after += 1
                if not depth:
                    result.append(line[i:end])
                    i = after
                    continue
        result.append(line[i])
        i += 1
    return "".join(result)


def docs_search_text(text):
    lines = []
    marker = None
    for line in text.splitlines(keepends=True):
        opening = FENCE.match(line)
        if marker:
            lines.append(line)
            if re.match(r"^\s*" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}\s*$", line):
                marker = None
        elif opening:
            marker = opening.group(1)
            lines.append(line)
        elif not re.match(r"^\s{0,3}\[[^\]\n]+\]:\s*", line):
            lines.append(visible_link_text(line))
    return "".join(lines)


def markdown_blocks(text):
    """Keep fences, tables and list steps atomic; yield exact, ordered slices."""
    lines = text.splitlines(keepends=True)
    start = 0
    i = 0
    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        fence = FENCE.match(lines[i])
        item = LIST_ITEM.match(lines[i])
        if fence:
            marker = fence.group(1)
            i += 1
            while i < len(lines):
                closing = re.match(r"^\s*" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}\s*$", lines[i])
                i += 1
                if closing:
                    break
        elif item:
            # A sibling list item starts a new block. Indented continuation,
            # nested items, blank lines and their fenced code stay in this step.
            indent = len(item.group(1))
            i += 1
            marker = None
            while i < len(lines):
                line = lines[i]
                if marker:
                    if re.match(r"^\s*" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}\s*$", line):
                        marker = None
                elif line.strip():
                    width = len(line) - len(line.lstrip())
                    if width <= indent:
                        break
                    opening = FENCE.match(line)
                    if opening:
                        marker = opening.group(1)
                i += 1
        elif "|" in lines[i] and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{3,}", lines[i + 1]):
            i += 2
            while i < len(lines) and lines[i].strip() and "|" in lines[i]:
                i += 1
        elif re.match(r"^\s{0,3}#{1,6}\s", lines[i]):
            i += 1
        else:
            i += 1
            while i < len(lines) and lines[i].strip():
                if FENCE.match(lines[i]) or LIST_ITEM.match(lines[i]) or re.match(r"^\s{0,3}#{1,6}\s", lines[i]):
                    break
                if "|" in lines[i] and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{3,}", lines[i + 1]):
                    break
                i += 1
        yield "".join(lines[start:i])
        start = i
    if start < len(lines):
        yield "".join(lines[start:])


def search_passages(text):
    """Pack whole blocks. An oversized atomic block gets its own passage, never a cut fence."""
    pending = ""
    for block in markdown_blocks(text):
        if pending and len(pending) + len(block) > SEARCH_CHARS:
            yield pending
            pending = ""
        if len(block) > SEARCH_CHARS:
            yield block
        else:
            pending += block
    if pending:
        yield pending


def identifier_suffixes(token):
    token = token.replace("?.", ".")
    yield token
    # Property chains often have a local receiver (config.rollback.toLastSuccess).
    # Include property suffixes, without conflating case or fuzzy spellings.
    if "/" not in token and ":" not in token:
        parts = token.split(".")
        for i in range(1, len(parts)):
            yield ".".join(parts[i:])


def technical_terms(text, scope):
    """Return (term, line) occurrences; line 0 explicitly means a whole-file JSON path."""
    for line_no, line in enumerate(text.split("\n"), 1):
        if scope == "docs":
            # Plain prose words are not identifiers. Backticks admit bare names;
            # dotted/camel/snake/flag spellings also work in fences and tables.
            spans = [match.span(1) for match in re.finditer(r"`+([^`\n]+)`+", line)]
            for match in IDENTIFIER.finditer(line):
                token = match.group()
                marked = any(start <= match.start() and match.end() <= end for start, end in spans)
                if marked or re.search(r"[._/$:-]|[a-z][A-Z]", token):
                    for term in identifier_suffixes(token):
                        yield term, line_no
        else:
            for match in IDENTIFIER.finditer(line):
                for term in identifier_suffixes(match.group()):
                    yield term, line_no
    if scope == "docs":
        return
    try:
        value = json.loads(text)
    except (ValueError, RecursionError):
        return

    def paths(value, prefix=()):
        if isinstance(value, dict):
            for key, child in value.items():
                path = (*prefix, key)
                if len(path) > 1 and all(IDENTIFIER.fullmatch(part) for part in path):
                    for term in identifier_suffixes(".".join(path)):
                        if "." in term:
                            yield term, 0
                yield from paths(child, path)
        elif isinstance(value, list):
            for child in value:
                yield from paths(child, prefix)

    yield from paths(value)


def matching_passage(text, query, size=220):
    """Choose the window covering the most distinct query tokens, not the section's lead."""
    words = sorted(set(re.findall(r"[A-Za-z0-9_$]+", query.lower())))
    if not words:
        return re.sub(r"\s+", " ", text[:size]).strip()
    matches = list(re.finditer(r"(?i)\b(?:" + "|".join(map(re.escape, words)) + ")", text))
    if not matches:
        return re.sub(r"\s+", " ", text[:size]).strip()
    best = None
    start = 0
    counts = Counter()
    begin = end = 0
    for match in matches:
        left = max(0, match.start() - 55)
        while end < len(matches) and matches[end].start() < left + size:
            counts[matches[end].group().lower()] += 1
            end += 1
        while begin < end and matches[begin].start() < left:
            word = matches[begin].group().lower()
            counts[word] -= 1
            if not counts[word]:
                del counts[word]
            begin += 1
        score = (len(counts), end - begin, -left)
        if best is None or score > best:
            best, start = score, left
    passage = re.sub(r"\s+", " ", text[start:start + size]).strip()
    return ("…" if start else "") + passage + ("…" if start + size < len(text) else "")


def markdown_table(rows, columns, json_output=False):
    if json_output:
        print(json.dumps(rows, ensure_ascii=False))
        return
    def cell(value):
        if value is None:
            return ""
        if isinstance(value, (list, dict)):
            value = json.dumps(value, ensure_ascii=False)
        return re.sub(r"\s+", " ", str(value)).replace("|", r"\|").strip()
    print("| " + " | ".join(columns) + " |")
    print("| " + " | ".join("---" for _ in columns) + " |")
    for row in rows:
        print("| " + " | ".join(cell(row.get(column)) for column in columns) + " |")


def query_rows(cache, statement, readonly=True):
    result = duckdb(cache, statement, capture=True, json_output=True, readonly=readonly)
    return json.loads(result.stdout.strip() or "[]")


def sql_string(value):
    if "\x00" in value:
        raise ValueError("SQL inputs cannot contain a NUL character")
    return "'" + value.replace("'", "''") + "'"


def duckdb(cache, sql, capture=False, readonly=True, json_output=False):
    args = ["duckdb", str(cache), "-bail", "-init", os.devnull]
    if readonly:
        args.append("-readonly")
    args.append("-json" if json_output else "-markdown")
    try:
        return subprocess.run([*args, "-c", sql], check=True, text=True, capture_output=capture)
    except FileNotFoundError as error:
        raise ValueError("DuckDB CLI not found on PATH. Install the standalone duckdb executable "
                         "from https://duckdb.org/install/ and add its directory to PATH. "
                         "The Python duckdb package alone does not provide this command.") from error


def install_fts(wheel=None):
    """Install a matching signed extension from a downloaded or local PyPI wheel."""
    version = query_rows(":memory:", "SELECT version() AS version", readonly=False)[0]["version"].lstrip("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("The FTS wheel installer requires a stable DuckDB release, not a development build")
    with tempfile.TemporaryDirectory(prefix="hankweave-fts-") as temporary:
        directory = pathlib.Path(temporary)
        if wheel is None:
            platform = query_rows(":memory:", "PRAGMA platform", readonly=False)[0]["platform"]
            wheel_platform = {
                "osx_arm64": "macosx_11_0_arm64", "osx_amd64": "macosx_11_0_x86_64",
                "linux_amd64": "manylinux2014_x86_64", "linux_amd64_gcc4": "manylinux2014_x86_64",
                "linux_arm64": "manylinux2014_aarch64", "linux_arm64_gcc4": "manylinux2014_aarch64",
                "windows_amd64": "win_amd64",
            }.get(platform)
            if wheel_platform is None:
                raise ValueError(f"No FTS wheel mapping for DuckDB platform {platform}; use a matching --wheel")
            # Python may run under emulation while DuckDB is native. Only the
            # extension binary is used, so the wheel's Python requirement is irrelevant.
            subprocess.run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--no-deps",
                            "--index-url", "https://pypi.org/simple", "--platform", wheel_platform,
                            "--ignore-requires-python", "--dest", str(directory),
                            f"duckdb-extension-fts=={version}"], check=True)
            wheels = list(directory.glob("*.whl"))
            if len(wheels) != 1:
                raise ValueError("Expected one platform-compatible duckdb-extension-fts wheel")
            wheel = wheels[0]
        with zipfile.ZipFile(pathlib.Path(wheel).expanduser()) as archive:
            metadata = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
            if len(metadata) != 1:
                raise ValueError("FTS wheel must contain one package metadata record")
            text = archive.read(metadata[0]).decode("utf-8")
            if (not re.search(r"(?m)^Name: duckdb[-_]extension[-_]fts\s*$", text)
                    or not re.search(r"(?m)^Version: " + re.escape(version) + r"\s*$", text)):
                raise ValueError(f"Expected duckdb-extension-fts=={version} to match the DuckDB CLI")
            extensions = [name for name in archive.namelist()
                          if pathlib.PurePosixPath(name).name == "fts.duckdb_extension"]
            if len(extensions) != 1:
                raise ValueError("FTS wheel must contain one fts.duckdb_extension binary")
            # Never extract wheel paths or execute its Python package. DuckDB
            # validates the extension's version, platform and signature on load.
            extension = directory / "fts.duckdb_extension"
            extension.write_bytes(archive.read(extensions[0]))
        duckdb(":memory:", f"INSTALL {sql_string(str(extension))}; LOAD fts;", capture=True, readonly=False)
    print(f"Installed and loaded FTS for DuckDB {version}.")

def resolve_source(explicit=None):
    source = explicit if explicit is not None else os.environ.get("HANKWEAVE_DOCS_PARQUET")
    if source is None:
        package = pathlib.Path(__file__).resolve().parents[1]
        filename = f"hankweave-docs-{DEFAULT_VERSION}.parquet"
        bundled = package / "data" / filename
        root = package.parents[1]
        if bundled.is_file():
            source = str(bundled)
        elif (root / "runner/publish/parquet.py").is_file() and (root / "runner/release.ts").is_file():
            source = str(root / "out" / DEFAULT_VERSION / filename)
        else:
            raise ValueError("No parquet selected: pass --parquet PATH or set HANKWEAVE_DOCS_PARQUET")
    return resolve_location(source)


def resolve_location(source):
    if not source:
        raise ValueError("The selected parquet path is empty")
    scheme = urllib.parse.urlsplit(source).scheme.lower()
    if scheme in ("http", "https"):
        return source
    if "://" in source:
        raise ValueError("Use a local file path or an explicit HTTP(S) URL")
    path = pathlib.Path(source).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError(f"Not a parquet file: {path}")
    return str(path)


def stream_hash(handle, destination=None):
    digest = hashlib.sha256()
    while block := handle.read(1024 * 1024):
        digest.update(block)
        if destination is not None:
            destination.write(block)
    return digest.hexdigest()


def source_manifest(source):
    if urllib.parse.urlsplit(source).scheme.lower() in ("http", "https"):
        return {}
    manifest_path = pathlib.Path(source).with_suffix(".manifest.json")
    if not manifest_path.is_file():
        return {}
    manifest = json.loads(manifest_path.read_text())
    if not isinstance(manifest, dict):
        raise ValueError("Selected parquet manifest must be a JSON object")
    return manifest


def validate_digest(digest, manifest):
    if manifest.get("sha256") and digest != manifest["sha256"]:
        raise ValueError("Selected parquet bytes differ from their publication manifest")


def parquet_info(source, parquet, digest, manifest):
    validate_digest(digest, manifest)
    relation = f"read_parquet({sql_string(str(parquet))})"
    columns = {row["column_name"] for row in query_rows(
        ":memory:", f"DESCRIBE SELECT * FROM {relation}", readonly=False
    )}
    if not {"id", "ptype", "body_md"}.issubset(columns):
        raise ValueError("Selected parquet lacks required public fields: id, ptype, body_md")
    counts = query_rows(":memory:", f"SELECT ptype, count(*) AS rows FROM {relation} GROUP BY ptype ORDER BY ptype", readonly=False)
    versions = query_rows(":memory:", f"SELECT DISTINCT version FROM {relation} WHERE version IS NOT NULL ORDER BY version", readonly=False) if "version" in columns else []
    source_bodies = query_rows(":memory:", f"""
SELECT count(*) AS rows, count(body_md) AS bodies FROM {relation} WHERE ptype='source'
""", readonly=False)[0]
    return {
        "source": source,
        "sha256": digest,
        "version": manifest.get("version") or (versions[0]["version"] if len(versions) == 1 else None),
        "format": manifest.get("format"),
        "source_commit": manifest.get("source_commit"),
        "status": manifest.get("status"),
        "accepted": manifest.get("accepted"),
        "canonical_docs_url": manifest.get("canonical_docs_url"),
        "canonical_url_status": manifest.get("canonical_url_status"),
        "rows": sum(row["rows"] for row in counts),
        "rows_by_ptype": {row["ptype"]: row["rows"] for row in counts},
        "capabilities": {
            "full_source_bodies": bool(source_bodies["rows"]) and source_bodies["rows"] == source_bodies["bodies"],
            "source_symbols": True if "source_symbols" in columns else None,
            "evidence_graph": True if {"links_out", "deps", "fixture_role", "fixture_manifest_id"}.issubset(columns) else None,
        },
    }


def selected_parts(explicit=None, source_explicit=None):
    source = resolve_source(explicit)
    manifest = source_manifest(source)
    expected = manifest.get("source_pack")
    if expected is not None:
        if (not isinstance(expected, dict) or not isinstance(expected.get("file"), str)
                or pathlib.Path(expected["file"]).name != expected["file"]
                or not expected["file"].endswith(".parquet")
                or not re.fullmatch(r"[0-9a-f]{64}", str(expected.get("sha256", "")))
                or not expected.get("version")):
            raise ValueError("Invalid source_pack descriptor in docs manifest")
    companion = source_explicit if source_explicit is not None else os.environ.get("HANKWEAVE_SOURCE_PARQUET")
    if companion is None and expected and urllib.parse.urlsplit(source).scheme.lower() not in ("http", "https"):
        base = pathlib.Path(source).parent
        candidates = [base / expected["file"]]
        if base.name == "data":
            candidates.append(base.parent.parent / "source" / expected["file"])
        for candidate in candidates:
            if candidate.exists():
                companion = str(candidate)
                break
    parts = [(source, manifest)]
    if companion is not None:
        companion = resolve_location(companion)
        parts.append((companion, source_manifest(companion)))
    notices = []
    for label, predicate in (
        ("unaccepted", lambda item: item.get("accepted") is False or item.get("status") == "unaccepted"),
        ("URLs marked planned", lambda item: item.get("canonical_url_status") == "planned"),
    ):
        affected = ["base" if index == 0 else "source" for index, (_, item) in enumerate(parts) if predicate(item)]
        if affected:
            notices.append(f"{label} ({', '.join(affected)})")
    if notices:
        print("hankweave-docs: bundle metadata: " + "; ".join(notices) + ". See info for details.", file=sys.stderr)
    return parts, expected


def parquet_relation(parquets):
    return "read_parquet([" + ",".join(sql_string(str(path)) for path in parquets) + "], union_by_name=true)"


def load_parts(parts, expected, directory, snapshot=False):
    parquets, sources = [], []
    for number, (source, manifest) in enumerate(parts):
        remote = urllib.parse.urlsplit(source).scheme.lower() in ("http", "https")
        parquet = pathlib.Path(directory) / f"part-{number}.parquet" if remote or snapshot else pathlib.Path(source)
        handle = urllib.request.urlopen(source, timeout=60) if remote else open(source, "rb")
        with handle:
            if remote or snapshot:
                with parquet.open("wb") as destination:
                    digest = stream_hash(handle, destination)
            else:
                digest = stream_hash(handle)
        metadata = parquet_info(source, parquet, digest, manifest)
        metadata["bytes"] = parquet.stat().st_size
        metadata["role"] = "source" if number else manifest.get("role") or ("corpus" if metadata["rows_by_ptype"].get("source") else "docs")
        parquets.append(parquet)
        sources.append(metadata)
    if sources[0]["role"] == "docs" and sources[0]["rows_by_ptype"].get("source"):
        raise ValueError("Docs pack must not contain source rows")
    if len(sources) == 2:
        base, companion = sources
        if companion["rows_by_ptype"] != {"source": companion["rows"]} or not companion["rows"]:
            raise ValueError("Source pack must contain only source rows")
        version = (expected or {}).get("version") or base["version"]
        if not version or companion["version"] != version or base["version"] != version:
            raise ValueError("Source pack version differs from selected docs")
        for parquet in parquets:
            versions = query_rows(":memory:", f"SELECT DISTINCT version FROM {parquet_relation([parquet])}", readonly=False)
            if versions != [{"version": version}]:
                raise ValueError("Source pack and docs rows must share the selected version")
        if parts[1][1].get("role") not in (None, "source"):
            raise ValueError("Companion manifest does not describe a source pack")
        if expected:
            for key in ("sha256", "bytes", "rows", "version"):
                if expected.get(key) is not None and companion[key] != expected[key]:
                    raise ValueError(f"Source pack {key} differs from docs source_pack descriptor")
        commit = (expected or {}).get("source_commit") or base["source_commit"]
        if commit and companion["source_commit"] and companion["source_commit"] != commit:
            raise ValueError("Source pack source_commit differs from selected docs")
        if (parts[0][1].get("set_digest") and parts[1][1].get("set_digest")
                and parts[0][1]["set_digest"] != parts[1][1]["set_digest"]):
            raise ValueError("Source pack set_digest differs from selected docs")
    duplicates = query_rows(":memory:", f"""
SELECT id FROM {parquet_relation(parquets)} GROUP BY id HAVING count(*)>1 LIMIT 1
""", readonly=False)
    if duplicates:
        raise ValueError(f"Duplicate row ID in selected corpus: {duplicates[0]['id']}")
    metadata = dict(sources[0])
    counts = Counter()
    for part in sources:
        counts.update(part["rows_by_ptype"])
    metadata["rows"] = sum(counts.values())
    metadata["rows_by_ptype"] = dict(sorted(counts.items()))
    source_part = next((part for part in sources if part["rows_by_ptype"].get("source")), None)
    metadata["capabilities"] = dict(metadata["capabilities"])
    if source_part:
        for key in ("full_source_bodies", "source_symbols"):
            metadata["capabilities"][key] = source_part["capabilities"][key]
    metadata["sources"] = sources
    metadata["source_pack"] = {
        "available": source_part is not None,
        "expected": expected,
        "source": source_part["source"] if source_part else None,
    }
    return parquets, metadata


def info(explicit=None, json_output=False, source_explicit=None):
    parts, expected = selected_parts(explicit, source_explicit)
    # Introspection hashes and inspects the actual selected files without FTS
    # or even consulting the cache directory.
    with tempfile.TemporaryDirectory(prefix="hankweave-docs-info-") as tmp:
        _, metadata = load_parts(parts, expected, tmp)
    if json_output:
        print(json.dumps(metadata, ensure_ascii=False))
        return
    for key in ("source", "sha256", "version", "format", "source_commit", "status", "accepted",
                "canonical_docs_url", "canonical_url_status"):
        value = metadata[key]
        print(f"{key}: {'unknown' if value is None else json.dumps(value) if isinstance(value, bool) else value}")
    print(f"rows: {metadata['rows']} " + json.dumps(metadata["rows_by_ptype"], ensure_ascii=False))
    print("capabilities: " + ", ".join(
        f"{key}={'unknown' if value is None else str(value).lower()}"
        for key, value in metadata["capabilities"].items()
    ))
    print("sources: " + json.dumps(metadata["sources"], ensure_ascii=False))
    print("source_pack: " + json.dumps(metadata["source_pack"], ensure_ascii=False))


def cache_identity(cache_dir, metadata):
    identity = {
        "format": CACHE_FORMAT, "source": metadata["source"], "sha256": metadata["sha256"],
        "sources": [{key: part[key] for key in ("source", "sha256")} for part in metadata["sources"]],
    }
    key = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return cache_dir / ("hankweave-docs-" + key + ".duckdb"), identity


def build_search_data(staging):
    sections = defaultdict(list)
    for section in query_rows(staging, "SELECT * FROM chunks ORDER BY page, ord"):
        sections[section["page"]].append(section)
    passages_path = staging.parent / "passages.jsonl"
    terms_path = staging.parent / "terms.jsonl"
    with passages_path.open("w") as passages_file, terms_path.open("w") as terms_file:
        for page in query_rows(staging, "SELECT id, title, scope, body_md, is_binary_fixture::INTEGER AS is_binary_fixture FROM pages ORDER BY id"):
            body = page["body_md"] or ""
            stored = sections[page["id"]]
            # Sectionless fixture files still participate in search. Ordinal zero
            # is a search-only whole-file parent; stored chunks are never changed.
            parents = stored or [{
                "chunk_id": page["id"] + "#0", "page": page["id"], "ord": 0,
                "anchor": "", "heading": page["title"], "text": body, "chars": len(body),
            }]
            for section in parents:
                # The publisher appends this navigation-only tail after prose.
                # Keep it in raw passages/reads, but never score its repetitions.
                tail = NAVIGATION_TAIL.search(section["text"]) if page["scope"] == "docs" else None
                search_end = tail.start() if tail else len(section["text"])
                offset = 0
                for sub_ord, text in enumerate(search_passages(section["text"]), 1):
                    visible = text[:max(0, search_end - offset)]
                    if page["scope"] == "docs":
                        visible = docs_search_text(visible)
                    scoring = section["heading"] + "\n" + visible if visible.strip() else ""
                    offset += len(text)
                    row = {
                        "subchunk_id": json.dumps([page["id"], section["ord"], sub_ord], separators=(",", ":")),
                        "parent_id": section["chunk_id"], "page": page["id"], "ord": section["ord"],
                        "anchor": section["anchor"], "sub_ord": sub_ord, "heading": section["heading"],
                        "text": text, "chars": len(text), "parent_chars": section["chars"],
                        "search_text": scoring,
                        "oversized": len(text) > SEARCH_CHARS,
                    }
                    passages_file.write(json.dumps(row) + "\n")
            # Count against full body once, not overlapping declaration windows.
            # Docs anchors are used only when their exact text occurs here.
            anchors = {}
            cursor = 0
            if page["scope"] == "docs":
                for section in stored:
                    start = body.find(section["text"], cursor)
                    if start < 0 or not section["text"]:
                        continue
                    cursor = start + len(section["text"])
                    first = body.count("\n", 0, start) + 1
                    last = first + section["text"].rstrip("\n").count("\n")
                    for line in range(first, last + 1):
                        anchors[line] = section["anchor"]
            file_text = page["scope"] == "source" or (page["scope"] == "fixture" and not page["is_binary_fixture"])
            counts = Counter()
            for term, line in technical_terms(body, page["scope"]):
                anchor = "L" + str(line) if file_text and line else anchors.get(line, "")
                counts[term, anchor] += 1
            for (term, anchor), count in sorted(counts.items()):
                terms_file.write(json.dumps({
                    "term": term, "page": page["id"], "anchor": anchor, "scope": page["scope"], "count": count,
                }) + "\n")
    # Explicit schemas also allow an empty corpus/term file and avoid JSON
    # inference converting technical identifiers or all-null anchors to numbers.
    duckdb(staging, f"""
CREATE TABLE search_chunks (
    subchunk_id VARCHAR PRIMARY KEY, parent_id VARCHAR, page VARCHAR, ord BIGINT,
    anchor VARCHAR, sub_ord BIGINT, heading VARCHAR, text VARCHAR, chars BIGINT, search_text VARCHAR,
    parent_chars BIGINT, oversized BOOLEAN
);
CREATE TABLE terms (term VARCHAR, page VARCHAR, anchor VARCHAR, scope VARCHAR, count BIGINT);
COPY search_chunks FROM {sql_string(str(passages_path))} (FORMAT JSON);
COPY terms FROM {sql_string(str(terms_path))} (FORMAT JSON);
CREATE INDEX terms_exact ON terms(term);
""", capture=True, readonly=False)


def build_graph(staging):
    duckdb(staging, """
CREATE TABLE graph_edges AS
WITH legacy_candidates AS (
  SELECT version, url AS href, id FROM pages WHERE url IS NOT NULL AND url<>''
  UNION
  SELECT version, regexp_replace(url,'^https?://[^/]+',''), id FROM pages WHERE url IS NOT NULL AND url<>''
), legacy_urls AS (
  SELECT version, href, min(id) AS id FROM legacy_candidates
  GROUP BY version, href HAVING count(*)=1
), expanded AS (
  SELECT id AS source_id, version, evidence_metadata, unnest(links_out) AS l FROM pages
), links AS (
  SELECT p.source_id, coalesce(l.kind, 'link') AS kind,
         coalesce(l.target_id, legacy.id) AS target_id, l.href, l.anchor,
         l.source_anchor, l.line_start, l.line_end, l.text AS label,
         CASE WHEN coalesce(l.target_id, legacy.id) IS NULL THEN 'unresolved' ELSE 'resolved' END AS status,
         []::VARCHAR[] AS candidates
  FROM expanded p
  LEFT JOIN legacy_urls legacy ON NOT p.evidence_metadata AND l.target_id IS NULL
    AND legacy.version=p.version AND legacy.href=split_part(l.href,'#',1)
), raw_edges AS (
  SELECT * FROM links
  UNION ALL
  SELECT p.id, 'dependency', d.target_id, NULL, NULL, NULL, NULL, NULL, d.label, d.status, d.candidates
  FROM pages p, unnest(p.deps) AS t(d)
  UNION ALL
  SELECT id, 'related', unnest(related), NULL, NULL, NULL, NULL, NULL, NULL, 'resolved', []::VARCHAR[] FROM pages
  UNION ALL
  SELECT id, 'next', next, NULL, NULL, NULL, NULL, NULL, NULL, 'resolved', []::VARCHAR[] FROM pages WHERE next IS NOT NULL
  UNION ALL
  SELECT p.id, 'fixture-manifest', p.fixture_manifest_id, NULL, NULL, NULL, NULL, NULL, NULL, 'resolved', []::VARCHAR[]
  FROM pages p WHERE p.fixture_manifest_id IS NOT NULL AND p.fixture_manifest_id<>p.id
    AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id=p.id AND l.kind='fixture-manifest' AND l.target_id=p.fixture_manifest_id)
  UNION ALL
  SELECT p.fixture_manifest_id, 'fixture-member', p.id, NULL, NULL, NULL, NULL, NULL, NULL, 'resolved', []::VARCHAR[]
  FROM pages p WHERE p.fixture_manifest_id IS NOT NULL AND p.fixture_manifest_id<>p.id
    AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id=p.fixture_manifest_id AND l.kind='fixture-member' AND l.target_id=p.id)
)
SELECT DISTINCT e.source_id, e.kind, e.target_id, e.href, e.anchor, e.source_anchor,
       e.line_start, e.line_end, e.label,
       CASE WHEN p.id IS NULL AND e.target_id IS NOT NULL
                 AND (e.kind='source-citation' OR starts_with(e.target_id, 'source/')) THEN 'missing-source'
            WHEN e.status='resolved' AND p.id IS NULL THEN 'unresolved' ELSE e.status END AS status, e.candidates
FROM raw_edges e LEFT JOIN pages p ON p.id=e.target_id;
""", capture=True, readonly=False)


def build_cache(staging, parquets, identity):
    # Normalize only metadata that changed across public editions. Required
    # reading columns still fail closed on malformed/non-public input.
    columns = {row["column_name"]: row["column_type"] for row in query_rows(
        staging, f"DESCRIBE SELECT * FROM {parquet_relation(parquets)}", readonly=False
    )}
    link_shape = json.dumps([{
        "href": "VARCHAR", "target_id": "VARCHAR", "anchor": "VARCHAR", "text": "VARCHAR",
        "kind": "VARCHAR", "source_anchor": "VARCHAR", "line_start": "BIGINT", "line_end": "BIGINT",
    }])
    dep_type = "STRUCT(label VARCHAR, target_id VARCHAR, status VARCHAR, candidates VARCHAR[])[]"
    if "deps" not in columns:
        deps = f"[]::{dep_type}"
    elif columns["deps"].upper().startswith("VARCHAR"):
        deps = "list_transform(deps, d -> struct_pack(label := d, target_id := NULL::VARCHAR, status := 'unresolved', candidates := []::VARCHAR[]))"
    else:
        deps = "from_json(to_json(deps), " + sql_string(json.dumps([{
            "label": "VARCHAR", "target_id": "VARCHAR", "status": "VARCHAR", "candidates": ["VARCHAR"],
        }])) + ")"
    fixture_role = "fixture_role" if "fixture_role" in columns else "NULL::VARCHAR"
    fixture_manifest = "fixture_manifest_id" if "fixture_manifest_id" in columns else "NULL::VARCHAR"
    evidence_metadata = all(name in columns for name in ("deps", "fixture_role", "fixture_manifest_id"))
    diagrams = "diagrams" if "diagrams" in columns else "[]::STRUCT(n INTEGER, kind VARCHAR, title VARCHAR, mermaid VARCHAR, figure_url VARCHAR)[]"
    symbol_shape = json.dumps([{
        "name": "VARCHAR", "kind": "VARCHAR", "line_start": "BIGINT", "line_end": "BIGINT", "signature": "VARCHAR",
    }])
    symbols = ("from_json(to_json(source_symbols), " + sql_string(symbol_shape) + ")"
               if "source_symbols" in columns else
               "[]::STRUCT(name VARCHAR, kind VARCHAR, line_start BIGINT, line_end BIGINT, signature VARCHAR)[]")
    binary_payload = "content_bytes IS NOT NULL" if "content_bytes" in columns else "FALSE"
    # Keep flags typed BOOLEAN in SQL. Python-facing queries cast them to INTEGER:
    # some DuckDB CLI versions encode BOOLEAN values as JSON strings ("false").
    # Binary fixture payloads stay in the parquet, not in the search cache.
    source_identity = " UNION ALL ".join(
        f"SELECT {identity['format']} AS format, {sql_string(part['source'])} AS source, "
        f"{sql_string(part['sha256'])} AS sha256" for part in identity["sources"]
    )
    statement = f"""
CREATE TEMP VIEW corpus AS
SELECT *, CASE WHEN ptype='source' THEN 'source' WHEN ptype='fixture' THEN 'fixture' ELSE 'docs' END AS scope
FROM {parquet_relation(parquets)};
CREATE TABLE pages AS
SELECT id, slug, section AS site_section, title, quadrant, ptype, scope, version, url,
       body_md, word_count, aliases, related, next,
       from_json(to_json(links_out), {sql_string(link_shape)}) AS links_out, broken_links, digest,
       media_type, content_sha256, {diagrams} AS diagrams, {deps} AS deps,
       {fixture_role} AS fixture_role, {fixture_manifest} AS fixture_manifest_id,
       {str(evidence_metadata).upper()} AS evidence_metadata,
       {str("source_symbols" in columns).upper()} AS source_symbols_metadata,
       scope='fixture' AND ({binary_payload} OR media_type IS NOT NULL) AS is_binary_fixture
FROM corpus;
CREATE TABLE chunks AS
SELECT p.id || '#' || i::VARCHAR AS chunk_id, p.id AS page, p.title AS page_title,
       p.section AS site_section, p.quadrant, p.scope, p.version, p.url, i AS ord,
       p.sections[i].heading AS heading, p.sections[i].level AS level,
       p.sections[i].anchor AS anchor, p.sections[i].text AS text, length(p.sections[i].text) AS chars
FROM corpus p, generate_series(1, len(p.sections)) AS g(i);
CREATE TABLE source_symbols AS
SELECT id AS page, s.name, s.kind, s.line_start, s.line_end, s.signature
FROM (SELECT id, unnest({symbols}) AS s FROM corpus WHERE scope='source');
CREATE INDEX source_symbols_page ON source_symbols(page);
CREATE TABLE source_identity AS {source_identity};
"""
    duckdb(staging, statement, capture=True, readonly=False)
    build_search_data(staging)
    build_graph(staging)
    try:
        duckdb(staging, "LOAD fts;", capture=True, readonly=False)
    except subprocess.CalledProcessError:
        try:
            duckdb(staging, "INSTALL fts FROM 'https://extensions.duckdb.org'; LOAD fts;", capture=True, readonly=False)
        except subprocess.CalledProcessError as error:
            raise ValueError("FTS is unavailable and its extension repository could not be used. "
                             "Run hankweave-docs.sh install-fts to download a matching PyPI wheel, or "
                             "hankweave-docs.sh install-fts --wheel /path/to/duckdb_extension_fts.whl offline. "
                             "See SKILL.md#setup. DuckDB reported:\n" + (error.stderr or str(error))) from error
    # FTS binds after the search-only table is materialized; whole sections
    # remain separately available to SQL and exact read consumers.
    duckdb(staging, "LOAD fts; PRAGMA create_fts_index('search_chunks', 'subchunk_id', 'search_text'); CHECKPOINT;",
           capture=True, readonly=False)


def ensure_index(explicit=None, source_explicit=None, scope=None):
    parts, expected = selected_parts(explicit, source_explicit)
    cache_setting = os.environ.get("HANKWEAVE_DOCS_CACHE")
    if cache_setting == "":
        raise ValueError("HANKWEAVE_DOCS_CACHE must name a cache directory, not an empty path")
    cache_dir = pathlib.Path(cache_setting).expanduser() if cache_setting is not None else pathlib.Path.home() / ".hankweave/docs"
    cache_dir = cache_dir.resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".hankweave-docs-", dir=cache_dir) as tmp:
        parquets, metadata = load_parts(parts, expected, tmp)
        if scope == "source" and not metadata["source_pack"]["available"]:
            raise ValueError(MISSING_SOURCE)
        cache, identity = cache_identity(cache_dir, metadata)
        if not cache.is_file():
            # Snapshot local bytes only for a cold generation. The second hash
            # binds the key to what is indexed even if a local file was replaced.
            # Remote parts are already captured; never download them twice.
            captured = [
                (str(parquet), {**manifest, "sha256": part["sha256"]})
                if urllib.parse.urlsplit(source).scheme.lower() in ("http", "https")
                else (source, manifest)
                for (source, manifest), parquet, part in zip(parts, parquets, metadata["sources"])
            ]
            snapshot_dir = pathlib.Path(tmp) / "snapshot"
            snapshot_dir.mkdir()
            parquets, metadata = load_parts(captured, expected, snapshot_dir, snapshot=True)
            for part, (source, _) in zip(metadata["sources"], parts):
                part["source"] = source
            if metadata["source_pack"]["available"]:
                metadata["source_pack"]["source"] = next(
                    part["source"] for part in metadata["sources"] if part["rows_by_ptype"].get("source")
                )
            metadata["source"] = parts[0][0]
            cache, identity = cache_identity(cache_dir, metadata)
            if not cache.is_file():
                staging = pathlib.Path(tmp) / "index.duckdb"
                build_cache(staging, parquets, identity)
                # Same-filesystem promotion only after the database and FTS close.
                os.replace(staging, cache)
    return cache, {**identity, "source_pack": metadata["source_pack"]}


def no_results(cache, command, value, scope, contains=False):
    message = f"hankweave-docs: no {command} results for {value!r} in --scope {scope}."
    if command == "search":
        message += " Try distinctive nouns or identifiers rather than only common words; use term for an identifier."
        if scope in ("source", "all"):
            message += " Source search covers selected windows, not full files; use the full-body SQL recipe in reference.md for exhaustive prose checks."
    elif command == "term":
        message += " term matches identifiers, not arbitrary prose."
        tokens = list(dict.fromkeys(match.group() for match in IDENTIFIER.finditer(value)))
        if len(tokens) == 1 and tokens[0] != value:
            argument = ("-- " if tokens[0].startswith("-") else "") + shlex.quote(tokens[0])
            message += f" Delimiters are not part of the indexed identifier; try term {argument}."
        elif re.search(r"\s", value):
            message += " Use search for indexed prose or the full-body SQL recipe in reference.md for a literal phrase."
        elif not contains:
            argument = ("-- " if value.startswith("-") else "") + shlex.quote(value)
            message += f" Exact matching is case-sensitive; try term --contains {argument} for part of a name."
        else:
            message += " Try a different identifier fragment or use search for indexed prose."
    elif command == "neighbors":
        message += f" No stored links match this page/section/line selection. Omit filters for page-wide evidence, or use page {shlex.quote(value)} for its text."
    elif command == "toc":
        message += " Use toc --scope all to inspect the loaded scopes."
    else:
        basename = urllib.parse.urlsplit(value).path.rstrip("/").rsplit("/", 1)[-1]
        candidates = query_rows(cache, f"""
SELECT id, scope FROM pages WHERE lower(regexp_extract(id, '[^/]+$'))=lower({sql_string(basename)})
ORDER BY id LIMIT 5;""") if basename else []
        if candidates:
            message += " Available page IDs: " + "; ".join(
                f"{row['id']} (--scope {row['scope']})" for row in candidates) + ". Use the full ID."
        else:
            message += " Use toc --scope all or resolve to find an available page ID."
        if command == "outline":
            message += " A page without stored sections can still be read with page PAGE."
        elif command == "figures":
            message += " Not every page has a stored figure."
    print(message, file=sys.stderr)


def search(cache, terms, scope, limit=12, offset=0, all_results=False, json_output=False):
    filt = "TRUE" if scope == "all" else "scope=" + sql_string(scope)
    # Multiword questions/keyword bundles benefit from a procedural answer.
    # Single identifiers benefit modestly from reference. This uses query form,
    # not a list of privileged operational words, page IDs or example queries.
    multiword = len(terms.split()) > 1
    purpose = ("CASE WHEN quadrant IN ('how-to', 'howto', 'how-to guides') THEN 1.6 "
               "WHEN quadrant='tutorial' THEN 1.15 ELSE 1 END") if multiword else (
               "CASE WHEN quadrant='reference' THEN 1.15 ELSE 1 END")
    ranking = f"""LOAD fts;
WITH scored AS (
  SELECT s.*, p.scope, p.version, p.url, p.quadrant,
         fts_main_search_chunks.match_bm25(subchunk_id, {sql_string(terms)}, b := 0.3)
         * CASE WHEN p.scope='docs' THEN {purpose} ELSE 1 END AS score
  FROM search_chunks s JOIN pages p ON p.id=s.page WHERE {filt}
), subhits AS (
  SELECT *, row_number() OVER (PARTITION BY parent_id ORDER BY score DESC, sub_ord) AS best,
         count(*) OVER (PARTITION BY parent_id) AS subhits
  FROM scored WHERE score IS NOT NULL
), sections AS (
  SELECT *, row_number() OVER (PARTITION BY page ORDER BY score DESC, ord) AS rp
  FROM subhits WHERE best=1
)"""
    bounds = "" if all_results else f"LIMIT {limit} OFFSET {offset}"
    rows = query_rows(cache, ranking + f"""
SELECT page || CASE WHEN anchor='' THEN '' ELSE '#' || anchor END AS hit,
       scope, version, quadrant, ord AS section_ord, round(score, 3) AS score,
       parent_chars AS chars, subhits, url, search_text AS text, count(*) OVER () AS total
FROM sections WHERE rp<=3 ORDER BY score DESC, page, ord {bounds};""")
    for row in rows:
        row["snippet"] = matching_passage(row.pop("text"), terms)
    markdown_table(rows, ("hit", "scope", "version", "quadrant", "section_ord", "score", "chars", "subhits", "url", "snippet", "total"), json_output)
    total = rows[0]["total"] if rows else query_rows(cache, ranking + " SELECT count(*) AS total FROM sections WHERE rp<=3;")[0]["total"]
    if not total:
        no_results(cache, "search", terms, scope)
    elif not rows:
        print(f"hankweave-docs: offset {offset} is beyond {total} search results; use --offset 0.", file=sys.stderr)
    elif not all_results and offset + len(rows) < total:
        print(f"hankweave-docs: showing {offset + 1}-{offset + len(rows)} of {total} search results. "
              f"Continue search with --offset {offset + len(rows)} --limit {limit}, or --all.", file=sys.stderr)


def file_lines(text):
    """Only LF separates file lines; retain CRLF and final-newline presence."""
    parts = text.split("\n")
    return [part + "\n" for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def line_bounds(selector, single=False):
    match = re.fullmatch(r"L(\d+)" if single else r"L(\d+)(?:-L?(\d+))?", selector)
    if not match:
        raise ValueError("Expected L<number>" + ("" if single else " or L<start>-L<end>"))
    first = int(match[1])
    last = first if single else int(match[2] or match[1])
    if first < 1 or last < first:
        raise ValueError("Line selectors require positive, ascending one-based bounds")
    return first, last


def term_results(cache, term, scope, limit, offset, all_results, json_output, contains=False):
    filt = "TRUE" if scope == "all" else "scope=" + sql_string(scope)
    match = f"contains(lower(term), lower({sql_string(term)}))" if contains else f"term={sql_string(term)}"
    condition = f"{filt} AND {match}"
    counts = {row["scope"]: row["row_count"] for row in query_rows(cache, f"""
SELECT scope, count(*) AS row_count FROM terms WHERE {condition} GROUP BY scope;""")}
    total = sum(counts.values())
    bounds = "" if all_results else f"LIMIT {limit} OFFSET {offset}"
    rows = query_rows(cache, f"""
WITH hits AS (
  SELECT *, row_number() OVER (PARTITION BY scope ORDER BY page, anchor, term) AS scope_hit
  FROM terms WHERE {condition}
)
SELECT t.term, t.page, t.anchor, t.scope, t.count, p.version, p.url, {total} AS total
FROM hits t JOIN pages p ON p.id=t.page
ORDER BY t.scope_hit, CASE t.scope WHEN 'docs' THEN 0 WHEN 'source' THEN 1 ELSE 2 END {bounds};""")
    markdown_table(rows, ("term", "page", "anchor", "scope", "count", "version", "url", "total"), json_output)
    if not total:
        no_results(cache, "term", term, scope, contains)
        return
    scopes = ("docs", "source", "fixture") if scope == "all" else (scope,)
    summary = ", ".join(f"{name}={counts.get(name, 0)}" for name in scopes)
    shown = f"{offset + 1}-{offset + len(rows)}" if rows else "0"
    message = f"hankweave-docs: showing {shown} of {total} term rows ({summary})."
    if not all_results and offset + len(rows) < total:
        message += f" Continue term with --offset {offset + len(rows)} --limit {limit}, or --all."
    elif not rows:
        message += " The offset is beyond the last result; use --offset 0."
    print(message, file=sys.stderr)


def citation_previews(cache, rows):
    citations = [row for row in rows if row["kind"] in ("source-citation", "cited-by:source-citation")]
    ids = sorted({row["evidence_page"] for row in citations if row["evidence_page"]})
    files, symbols = {}, defaultdict(list)
    if ids:
        selected = ",".join(sql_string(id_) for id_ in ids)
        files = {row["id"]: file_lines(row["body_md"]) for row in query_rows(cache, f"""
SELECT id, body_md FROM pages WHERE scope='source' AND id IN ({selected});""")}
        for symbol in query_rows(cache, f"""
SELECT * FROM source_symbols WHERE page IN ({selected})
ORDER BY line_end-line_start, line_start DESC, name, kind;"""):
            symbols[symbol["page"]].append(symbol)
    for row in rows:
        row["preview"], row["symbol"] = None, None
        evidence_page = row.pop("evidence_page")
        lines = files.get(evidence_page)
        first, last = row["line_start"], row["line_end"]
        if row["kind"] not in ("source-citation", "cited-by:source-citation") or lines is None:
            continue
        if first is None or last is None or not 1 <= first <= last <= len(lines):
            continue
        row["preview"] = "".join(line[:240] for line in lines[first - 1:min(last, first + 2)])[:240]
        row["symbol"] = next((symbol["name"] for symbol in symbols[evidence_page]
                              if symbol["line_start"] <= first <= symbol["line_end"]), None)


def neighbors(cache, page_id, filt, limit, offset, all_results, json_output=False, anchor=None, region=None):
    selected = query_rows(cache, f"SELECT scope, evidence_metadata::INTEGER AS evidence_metadata, is_binary_fixture::INTEGER AS is_binary_fixture FROM pages WHERE {filt} AND id={sql_string(page_id)}")
    if not selected:
        raise ValueError("No matching page: check the page ID and --scope; use toc or resolve to discover IDs")
    if region is not None and (selected[0]["scope"] not in ("source", "fixture") or selected[0]["is_binary_fixture"]):
        raise ValueError("--lines requires source or text-fixture original file text, not docs or a binary descriptor")
    if not selected[0]["evidence_metadata"]:
        print("hankweave-docs: legacy evidence metadata; absent bindings remain unknown and string dependencies are unresolved.", file=sys.stderr)
    bounds = "" if all_results else f"LIMIT {limit} OFFSET {offset}"
    section_filter = "" if anchor is None else " AND source_anchor=" + sql_string(anchor)
    if region is not None:
        section_filter += " AND FALSE"
    incoming = "TRUE" if anchor is None else "FALSE"
    if region is not None:
        first, last = region
        incoming += f" AND line_start>=1 AND line_end>=line_start AND line_start<={last} AND line_end>={first}"
    adjacent = f"""
WITH adjacent AS (
  SELECT kind, target_id AS page, target_id AS evidence_page, href, anchor, source_anchor, line_start, line_end, label, status, candidates
  FROM graph_edges WHERE source_id={sql_string(page_id)} AND coalesce(target_id,'')<>source_id
    {section_filter}
  UNION ALL
  SELECT 'cited-by:' || kind, source_id, target_id, href, anchor, source_anchor, line_start, line_end, label, status, candidates
  FROM graph_edges WHERE target_id={sql_string(page_id)} AND source_id<>target_id
    AND {incoming}
)"""
    rows = query_rows(cache, adjacent + f"""
, diverse AS (
  SELECT *, row_number() OVER (
    PARTITION BY kind, page ORDER BY line_start, line_end, source_anchor, href, label
  ) AS target_hit FROM adjacent
), ranked AS (
  SELECT *, row_number() OVER (
    PARTITION BY kind ORDER BY target_hit, page, line_start, line_end, source_anchor, href, label
  ) AS kind_hit,
  CASE kind WHEN 'source-citation' THEN 0 WHEN 'fixture-manifest' THEN 1 WHEN 'dependency' THEN 2
            WHEN 'fixture-member' THEN 3 WHEN 'next' THEN 4 WHEN 'related' THEN 5
            WHEN 'link' THEN 6 WHEN 'source-import' THEN 7 ELSE 8 END AS priority
  FROM diverse
)
SELECT e.kind, e.page, coalesce(p.scope, CASE WHEN e.status='missing-source' THEN 'source' END) AS scope,
       p.version, e.label, e.status, e.candidates, e.source_anchor, e.anchor,
       e.line_start, e.line_end, p.fixture_role,
       coalesce(p.url, CASE WHEN e.status='missing-source' THEN e.href END) AS url,
       e.href, e.evidence_page, count(*) OVER () AS total
FROM ranked e LEFT JOIN pages p ON p.id=e.page
ORDER BY floor((e.kind_hit-1)/6), e.priority, e.kind, e.kind_hit {bounds};""")
    total = rows[0]["total"] if rows else query_rows(cache, adjacent + " SELECT count(*) AS total FROM adjacent;")[0]["total"]
    citation_previews(cache, rows)
    markdown_table(rows, ("kind", "page", "scope", "version", "label", "status", "candidates",
                          "source_anchor", "anchor", "line_start", "line_end", "symbol", "preview", "fixture_role", "url", "href", "total"), json_output)
    if not total:
        no_results(cache, "neighbors", page_id, selected[0]["scope"])
        return
    if not rows:
        print(f"hankweave-docs: offset {offset} is beyond {total} evidence results; use --offset 0.", file=sys.stderr)
    if anchor is not None:
        print("hankweave-docs: section-scoped outgoing evidence; omit --anchor for page-wide and incoming edges.", file=sys.stderr)
    if region is not None:
        print("hankweave-docs: incoming bounded evidence overlapping the requested file lines; page names the citing page.", file=sys.stderr)
    if any(row["preview"] is not None for row in rows):
        print("hankweave-docs: preview starts at the recorded citation bound (up to 3 lines / 240 characters); "
              "symbol contains its first line when metadata is available. Citation bounds are unchanged.", file=sys.stderr)
    if any(row["status"] == "missing-source" for row in rows):
        print("hankweave-docs: cited source bodies are unavailable; recorded target IDs, URLs and line bounds are retained. "
              "Attach the matching source pack with --source-parquet or HANKWEAVE_SOURCE_PARQUET for previews and reads.", file=sys.stderr)
    if any(row["scope"] == "fixture" or "fixture-" in row["kind"] for row in rows):
        print("hankweave-docs: fixture grouping is navigation, not proof that every member was executed; read the manifest's limits.", file=sys.stderr)
    if not all_results and (offset or len(rows) < total):
        shown = f"{offset + 1}-{offset + len(rows)}" if rows else "0"
        message = f"hankweave-docs: showing {shown} of {total} edges."
        if offset + len(rows) < total:
            message += f" Continue neighbors with --offset {offset + len(rows)} --limit {limit}, or --all."
        print(message, file=sys.stderr)


def query(cache, command, args, scope, limit=24, offset=0, all_results=False, json_output=False, anchor=None, region=None, at=None, contains=False):
    filt = "TRUE" if scope == "all" else "scope=" + sql_string(scope)
    value = sql_string(args[0]) if args else "''"
    if not query_rows(cache, "SELECT id FROM pages WHERE scope='source' LIMIT 1"):
        missing_target = args and command in ("read", "page", "outline", "neighbors", "figures", "resolve") and (
            args[0].startswith("source/") or query_rows(cache,
                f"SELECT target_id FROM graph_edges WHERE status='missing-source' AND target_id={value} LIMIT 1")
        )
        if scope == "source" or missing_target:
            raise ValueError(MISSING_SOURCE)
        if scope == "all":
            print("hankweave-docs: partial coverage: source pack unavailable; --scope all searches only available docs and fixtures. "
                  "Attach matching source with --source-parquet or HANKWEAVE_SOURCE_PARQUET.", file=sys.stderr)
    if command == "search":
        search(cache, " ".join(args), scope, limit, offset, all_results, json_output)
        return
    elif command == "term":
        term_results(cache, args[0], scope, limit, offset, all_results, json_output, contains)
        return
    elif command == "outline":
        if at is not None:
            selected = query_rows(cache, f"SELECT scope, source_symbols_metadata::INTEGER AS source_symbols_metadata FROM pages WHERE {filt} AND id={value}")
            if not selected or selected[0]["scope"] != "source":
                raise ValueError("outline --at requires a source page ID; check --scope source and toc or resolve")
            if not selected[0]["source_symbols_metadata"]:
                rows = []
                print("hankweave-docs: selected artifact lacks source symbol metadata; containing constructs are unknown. "
                      "Use read with explicit line bounds or page for original file text; outline windows do not establish containment.", file=sys.stderr)
            else:
                rows = query_rows(cache, f"""
SELECT s.name, s.kind, s.line_start, s.line_end, s.signature, p.url
FROM source_symbols s JOIN pages p ON p.id=s.page
WHERE s.page={value} AND s.line_start<={at} AND s.line_end>={at}
ORDER BY s.line_end-s.line_start, s.line_start DESC, s.name, s.kind;""")
                if not rows:
                    print("hankweave-docs: no recorded source construct contains this line; the file may be unsupported or the line outside a construct.", file=sys.stderr)
            markdown_table(rows, ("name", "kind", "line_start", "line_end", "signature", "url"), json_output)
            return
        statement = f"""SELECT ord, repeat('  ',greatest(level-1,0)) || heading AS outline,
anchor, chars, url FROM chunks WHERE {filt} AND page={value} ORDER BY ord;"""
    elif command == "read":
        statement = f"SELECT text FROM chunks WHERE {filt} AND page={value} AND anchor={sql_string(args[1])} ORDER BY ord;"
        selector = re.fullmatch(r"L(\d+)(?:-L?(\d+))?", args[1])
        files = []
        if selector:
            files = query_rows(cache, f"SELECT body_md, is_binary_fixture::INTEGER AS is_binary_fixture FROM pages WHERE {filt} AND id={value} AND scope IN ('source','fixture')")
            if files and files[0]["is_binary_fixture"]:
                raise ValueError("Binary fixture: body_md is a descriptor, not original file text; line reads are unavailable. "
                                 "Use page for the descriptor and its download link; original bytes remain in parquet content_bytes.")
        if selector and selector[2] is None:
            # An outline/search anchor still means its complete stored window.
            # Only an absent single-line anchor falls back to the full file;
            # an explicit Lx-Ly range always selects actual file lines.
            stored = query_rows(cache, statement)
            if stored:
                for row in stored:
                    sys.stdout.write(row["text"])
                return
        if selector and files:
            first, last = line_bounds(args[1])
            lines = file_lines(files[0]["body_md"])
            if last > len(lines):
                raise ValueError(f"File line range outside 1-{len(lines)}: {args[1]}")
            sys.stdout.write("".join(lines[first - 1:last]))
            return
    elif command == "page":
        statement = f"SELECT body_md AS text FROM pages WHERE {filt} AND id={value};"
    elif command == "figures":
        # New projections store absolute planned URLs. Older parquet keeps root-relative
        # figure paths; use its own page origin without rebinding it to another version.
        statement = f"""SELECT id AS page, d.n, d.kind, d.title,
CASE WHEN regexp_matches(d.figure_url, '^https?://') THEN d.figure_url
     ELSE regexp_replace(url, '^(https?://[^/]+).*$', '\\1') || d.figure_url END AS figure, d.mermaid
FROM (SELECT id, url, unnest(diagrams) AS d FROM pages WHERE {filt} AND id={value}) ORDER BY d.n;"""
    elif command == "toc":
        statement = f"SELECT id, scope, version, quadrant, title, word_count, url FROM pages WHERE {filt} ORDER BY site_section,id;"
    elif command == "resolve":
        lookup = args[0]
        parsed = urllib.parse.urlsplit(lookup)
        route_match = ""
        same_origin = "TRUE"
        version = re.match(r"^/(?:docs|source|fixtures)/(\d+\.\d+\.\d+(?:[-+][^/]+)?)(?:/|$)", parsed.path)
        if not version:
            version = re.match(r"^/(\d+\.\d+\.\d+(?:[-+][^/]+)?)/files(?:/|$)", parsed.path)
        edition = f" AND version={sql_string(version[1])}" if version else ""
        if parsed.scheme.lower() in ("http", "https") or lookup.startswith("/"):
            path = sql_string(parsed.path.rstrip("/"))
            origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.netloc else ""
            clean = sql_string((origin + parsed.path).rstrip("/"))
            same_origin = f"regexp_extract(url, '^https?://[^/]+')={sql_string(origin)}" if origin else "TRUE"
            # A URL's explicit edition and origin constrain every match,
            # including aliases and same-edition legacy route normalization.
            route_match = f"""OR rtrim(url,'/')={clean}
OR ({same_origin} AND (rtrim(regexp_replace(url,'^https?://[^/]+',''),'/')={path}
    OR EXISTS (SELECT 1 FROM unnest(aliases) AS names(alias) WHERE rtrim(alias,'/')={path})))"""
        statement = f"""SELECT id,title,scope,version,url FROM pages WHERE {filt}{edition}
AND (list_contains(aliases,{value}) OR id={value} OR slug={value} OR url={value}
     {route_match}) ORDER BY id;"""
        rows = query_rows(cache, statement)
        if not rows and not parsed.scheme and "/" not in lookup:
            rows = query_rows(cache, f"""SELECT id,title,scope,version,url FROM pages WHERE {filt}
AND regexp_extract(id, '[^/]+$')={value} ORDER BY id;""")
        legacy = re.fullmatch(r"/docs/(\d+\.\d+\.\d+(?:[-+][^/]+)?)(?:/(.*))?", parsed.path.rstrip("/"))
        if not rows and legacy:
            page_id = (legacy[2] or "").strip("/")
            ids = ["index", "start/introduction"] if page_id in ("", "start/introduction") else [page_id, page_id + "/index"]
            rows = query_rows(cache, f"""SELECT id,title,scope,version,url FROM pages
WHERE {filt} AND scope='docs' AND version={sql_string(legacy[1])} AND {same_origin}
AND (id IN ({','.join(sql_string(item) for item in ids)})
     OR list_contains(aliases,{sql_string('/' + page_id)})) ORDER BY id;""")
        if not rows and version:
            available = [row["version"] for row in query_rows(cache, "SELECT DISTINCT version FROM pages ORDER BY version")]
            if version[1] not in available:
                print(f"hankweave-docs: URL pins version {version[1]}; selected artifact contains "
                      f"{', '.join(available) or 'no editions'}. No version was substituted; select that edition's parquet to resolve it.", file=sys.stderr)
                markdown_table(rows, ("id", "title", "scope", "version", "url"), json_output)
                return
        if not rows:
            no_results(cache, command, lookup, scope)
        markdown_table(rows, ("id", "title", "scope", "version", "url"), json_output)
        return
    elif command == "neighbors":
        neighbors(cache, args[0], filt, limit, offset, all_results, json_output, anchor, region)
        return
    else:
        raise ValueError(f"Unknown command: {command}")
    if command in ("read", "page"):
        # Decode the CLI's JSON string instead of its list/table presentation:
        # preserve stored newlines, heading text, and final-newline presence.
        result = duckdb(cache, statement, capture=True, json_output=True)
        rows = json.loads(result.stdout.strip() or "[]")
        if not rows:
            if command == "page":
                raise ValueError("No matching page ID: check --scope; use toc or resolve to discover IDs. "
                                 "For fixture manifests, use neighbors on a known fixture member (--scope fixture).")
            raise ValueError("No matching text: check the page, --scope, and an anchor copied from outline")
        for row in rows:
            sys.stdout.write(row["text"])
    else:
        rows = query_rows(cache, statement)
        if not rows:
            no_results(cache, command, args[0] if args else "", scope)
        if json_output:
            print(json.dumps(rows, ensure_ascii=False))
        else:
            columns = {"outline": ("ord", "outline", "anchor", "chars", "url"),
                       "figures": ("page", "n", "kind", "title", "figure", "mermaid"),
                       "toc": ("id", "scope", "version", "quadrant", "title", "word_count", "url")}
            markdown_table(rows, columns[command])


def main():
    help_text = {
        "info": "info [--json]\nInspect selected parts, versions and hashes without a cache or FTS.",
        "build": "build [PARQUET] [--path]\nBuild the local search index. --path prints only its database path.",
        "install-fts": "install-fts [--wheel PATH]\nDownload a matching duckdb-extension-fts wheel from PyPI, or use a local wheel offline.\nOnly the extension binary is extracted; its Python package is not installed or executed.\nDuckDB keeps signature, platform and version checks enabled.",
        "search": "search WORDS... [--limit N] [--offset N] [--all] [--json]\nRank indexed passages and return section locators. Default: 12 results, at most 3 per page.\nSource search covers stored windows, not full source bodies.",
        "term": "term IDENTIFIER [--contains] [--limit N] [--offset N] [--all] [--json]\nDefault: exact, case-sensitive identifiers across full bodies, 24 rows.\n--contains matches a case-insensitive substring of identifier names, not arbitrary prose.\nFor flags, put options before --: term --scope all -- --start-new",
        "outline": "outline PAGE [--at LNUMBER] [--json]\nList stored sections and sizes. --at finds recorded containing source constructs.",
        "read": "read PAGE#ANCHOR | read PAGE ANCHOR\nReturn exact text. Source/text fixtures accept LSTART-LEND; an empty anchor selects the opening.\nUse page PAGE for the whole body. --json is not supported.",
        "page": "page PAGE\nReturn the entire stored body exactly. Use outline/read to avoid a very large response.",
        "neighbors": "neighbors PAGE[#ANCHOR] [--anchor ANCHOR | --lines LSTART-LEND] [--limit N] [--offset N] [--all] [--json]\nFollow stored evidence. --lines selects incoming citations; --anchor selects outgoing section links.",
        "resolve": "resolve ID_OR_URL [--json]\nResolve IDs, aliases, unqualified names and same-edition legacy URLs.\nAmbiguous names return alternatives. Explicit URL versions are never substituted.",
        "toc": "toc [--json]\nList available page IDs and sizes in the selected scope.",
        "figures": "figures PAGE [--json]\nList a page's stored figure URLs, captions and Mermaid.",
    }
    parser = argparse.ArgumentParser(
        prog="hankweave-docs.sh", add_help=False,
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Commands:
  info       Inspect selected parquet metadata and SHA256 without a cache or FTS.
  search     Rank matching passages; return complete-section locators and sizes.
  term       Find exact identifiers across full bodies, including source files.
  outline    List section anchors and sizes; --at finds source constructs.
  read       Return one exact stored section, or inclusive source/fixture lines.
  page       Return the entire stored page or file exactly; may be very large.
  neighbors  Follow section evidence, dependencies, fixtures or incoming citations.
  resolve    Find page IDs from an ID, slug, alias or URL.
  toc        List pages with word counts in the selected scope.
  figures    Return figure captions, URLs and verbatim Mermaid.
  build      Build the local search index explicitly.
  install-fts Install FTS from a matching PyPI wheel or --wheel PATH.

Use outline before large reads. Source search covers selected windows, not every
file line; term covers identifiers in full bodies. Put all options before --:
  term --scope all --limit 12 -- --start-new
JSON is an array for tabular queries and one object for info; read/page stay raw.""",
    )
    parser.add_argument("command", nargs="?", choices=tuple(help_text))
    parser.add_argument("args", nargs="*")
    parser.add_argument("-h", "--help", action="store_true", help="show general or command-specific help")
    parser.add_argument("--contains", action="store_true", help="term: case-insensitive substring of identifier names")
    parser.add_argument("--wheel", metavar="PATH", help="install-fts: use a local matching wheel without network access")
    parser.add_argument("--scope", choices=("docs", "source", "fixture", "all"), default="docs")
    parser.add_argument("--parquet", metavar="PATH_OR_URL", help="select base docs (otherwise HANKWEAVE_DOCS_PARQUET, then bundled default)")
    parser.add_argument("--source-parquet", metavar="PATH_OR_URL", help="attach optional source (otherwise HANKWEAVE_SOURCE_PARQUET or a matching local companion)")
    parser.add_argument("--path", action="store_true", help="build: print only the selected DuckDB cache path")
    parser.add_argument("--limit", type=int, help="search/term/neighbors: maximum rows (search: 12; others: 24)")
    parser.add_argument("--offset", type=int, default=0, help="search/term/neighbors: skip this many rows")
    parser.add_argument("--all", action="store_true", dest="all_results", help="search/term/neighbors: show every result")
    parser.add_argument("--json", action="store_true", help="tabular queries: JSON array; info: one metadata object")
    parser.add_argument("--anchor", help="neighbors: outgoing evidence from this exact source section")
    parser.add_argument("--lines", help="neighbors: incoming bounded evidence overlapping Lstart[-Lend]")
    parser.add_argument("--at", help="outline: source constructs containing this exact Lnumber")
    # Keep identifiers such as --start-new literal after an explicit -- separator.
    argv = sys.argv[1:]
    literal = []
    if "--" in argv:
        boundary = argv.index("--")
        argv, literal = argv[:boundary], argv[boundary + 1:]
    args = parser.parse_intermixed_args(argv)
    args.args.extend(literal)
    if args.help:
        if args.command:
            print("Usage: hankweave-docs.sh " + help_text[args.command])
            if args.command != "install-fts":
                print("\nShared options: --scope docs|source|fixture|all, --parquet PATH_OR_URL, --source-parquet PATH_OR_URL")
        else:
            parser.print_help()
        return
    if args.command is None:
        parser.error("Choose a command; use --help for the command list")
    if args.contains and args.command != "term":
        parser.error("--contains is only available with term")
    if args.wheel is not None and args.command != "install-fts":
        parser.error("--wheel is only available with install-fts")
    if args.command in ("read", "neighbors") and len(args.args) == 1 and "#" in args.args[0]:
        page_id, hit_anchor = args.args[0].split("#", 1)
        if args.command == "read":
            args.args = [page_id, hit_anchor]
        else:
            if args.anchor is not None or args.lines is not None:
                parser.error("A combined PAGE#ANCHOR means outgoing section evidence; do not combine it with --anchor or --lines")
            args.args[0], args.anchor = page_id, hit_anchor
    if args.command == "read" and len(args.args) < 2:
        parser.error("read requires PAGE#ANCHOR or PAGE ANCHOR (use '' for the opening section); "
                     "use page PAGE for the complete stored body")
    required = {"info": 0, "install-fts": 0, "search": 1, "term": 1, "outline": 1, "read": 2, "page": 1, "neighbors": 1, "resolve": 1, "toc": 0, "build": 0, "figures": 1}
    count = len(args.args)
    if count < required[args.command]:
        parser.error(f"{args.command} requires {required[args.command]} argument(s)")
    maximum = 1 if args.command == "build" else required[args.command]
    if args.command != "search" and count > maximum:
        message = f"{args.command} takes at most {maximum} argument(s)."
        if literal:
            message += " Everything after -- is literal query text. Move options before --; for example: term --scope all -- --start-new"
        elif args.command == "term":
            message += " Use one identifier, --contains for part of a name, or search for prose."
        parser.error(message)
    if args.command == "search" and not " ".join(args.args).strip():
        parser.error("search requires non-empty terms")
    if args.command == "term" and not args.args[0].strip():
        parser.error("term requires a non-empty exact identifier")
    if (args.limit is not None and args.limit < 1) or args.offset < 0:
        parser.error("--limit must be positive and --offset nonnegative")
    if args.command not in ("search", "neighbors", "term") and (args.limit is not None or args.offset or args.all_results):
        parser.error("--limit, --offset and --all are only available with search, neighbors or term")
    if args.limit is None:
        args.limit = 12 if args.command == "search" else 24
    if args.command != "neighbors" and (args.anchor is not None or args.lines is not None):
        parser.error("--anchor and --lines are only available with neighbors")
    if args.anchor is not None and args.lines is not None:
        parser.error("Choose --anchor for outgoing section evidence or --lines for incoming file-region evidence")
    if args.at is not None and args.command != "outline":
        parser.error("--at is only available with outline")
    try:
        region = line_bounds(args.lines) if args.lines is not None else None
        at = line_bounds(args.at, single=True)[0] if args.at is not None else None
    except ValueError as error:
        parser.error(str(error))
    if args.all_results and args.offset:
        parser.error("Choose either --all or --offset")
    if args.json and args.command in ("read", "page", "build", "install-fts"):
        parser.error("--json is only available with tabular queries or info")
    if args.path and args.command != "build":
        parser.error("--path is only available with build")
    if args.command == "build" and args.args and args.parquet is not None:
        parser.error("Choose either the positional parquet or --parquet, not both")
    source = args.args[0] if args.command == "build" and args.args else args.parquet
    if args.command == "install-fts":
        if args.parquet is not None or args.source_parquet is not None:
            parser.error("install-fts does not select a parquet; use --wheel for a local extension wheel")
        install_fts(args.wheel)
        return
    if args.command == "info":
        info(source, args.json, args.source_parquet)
        return
    cache, identity = ensure_index(source, args.source_parquet, args.scope)
    if args.command == "build":
        if args.path:
            print(cache)
        else:
            print(json.dumps({**identity, "cache": str(cache)}))
    else:
        query(cache, args.command, args.args, args.scope, args.limit, args.offset, args.all_results, args.json, args.anchor, region, at, args.contains)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(f"hankweave-docs: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
