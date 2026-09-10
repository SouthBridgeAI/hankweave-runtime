# Hankweave lookup reference

Read this when the quick workflow in `SKILL.md` does not cover pack selection, query output or direct SQL. Each public parquet retains one row per publishable document or file, with the same schema and IDs across the split. Search-only subchunks never replace the complete reading units. `scripts/hankweave-docs.sh` is the lookup helper, not the `hankweave` runtime CLI.

## Select and inspect the data

Base selection order is an explicit `--parquet` path, `HANKWEAVE_DOCS_PARQUET`, then the package's bundled `data/hankweave-docs-0.10.0.parquet`. In the development checkout only, the publisher can supply `out/0.10.0/hankweave-docs-0.10.0.parquet` when bundled data is absent. A missing or unreadable selected base is an error; there is no fallback to another checkout or remembered cache. An explicitly selected legacy single parquet containing docs, fixtures and source remains supported.

The core data file is about **1.92 MB**, with 623 docs and fixture rows (`ptype != 'source'`). The optional `hankweave-source-0.10.0.parquet` is about **10.51 MB**, with 693 source rows. Both parts preserve the original 1,316 rows and complete bodies; source references remain available when source bodies are absent. Each file has an adjacent `.manifest.json`.

Attach source with `--source-parquet PATH` or `HANKWEAVE_SOURCE_PARQUET`, in that order. Otherwise, when the docs manifest declares `source_pack`, the helper looks for its filename beside the selected docs parquet and in the package's sibling `../source/` directory. In the whole-repository layout these are `docs/hankweave-docs/data/` and `docs/source/`. An installed core normally has neither source copy. The helper never downloads source automatically.

```bash
bash scripts/hankweave-docs.sh info
bash scripts/hankweave-docs.sh info --parquet /absolute/path/to/docs.parquet --json
bash scripts/hankweave-docs.sh info --source-parquet /absolute/path/to/hankweave-source-0.10.0.parquet --json
bash scripts/build-index.sh
bash scripts/build-index.sh /absolute/path/to/hankweave-docs-0.10.0.parquet
bash scripts/hankweave-docs.sh toc --parquet /absolute/path/to/hankweave-docs-0.10.0.parquet
```

A one-command selection does not select either part for later commands. Keep passing the selection options, or export `HANKWEAVE_DOCS_PARQUET` and, when needed, `HANKWEAVE_SOURCE_PARQUET` for the session. Prefer verified local copies for repeated lookup.

Each adjacent `hankweave-docs-<version>.manifest.json` describes that file's SHA256, byte size, row counts, runtime version, public format and originating set. Its `role: docs` and `corpus_rows` distinguish core rows from full-corpus coverage; `source_pack` records the expected source filename, SHA256, bytes, rows, version and pinned source commit. The source manifest has `role: source` and its own file/hash/counts, with the same version, source commit and set digest. Review and planned-publication metadata remain in force.

The scripts reject bytes that disagree with a supplied manifest. An attached companion must match the expected hash and version, contain only source rows, and introduce no duplicate IDs. A missing optional pack means partial coverage; a present mismatched pack is an error. An index is not a release certificate: `status: unaccepted` or `accepted: false` remains a warning after indexing.

If an installed skill's edition differs from the user's runtime, update only this skill with `npx skills update hankweave-docs -g` for a global installation or `npx skills update hankweave-docs -p` for a project installation, then reread `info`. If the runtime remains older, explicitly select matching older docs and source; do not treat the newest docs as evidence for that runtime.

HTTP(S) sources are supported only as explicit selections. Every query downloads the current remote bytes to choose the correct cache; an unavailable source fails rather than silently returning stale remote content. Use URLs for artifacts that are actually published.

### Metadata without an index

`info` hashes the selected parts, checks adjacent local manifests when present, and inspects the parquets directly in memory. It does not build FTS, install an extension or create `HANKWEAVE_DOCS_CACHE`, even when a corrupt manifest is rejected. A remote selection is downloaded to a temporary directory outside the cache and removed after inspection; as with queries, no adjacent remote manifest is fetched.

The default display is a short metadata listing. `info --json` emits **one object**, not a query-result array:

| Field | Meaning |
|---|---|
| `source`, `sha256` | Resolved local base path or selected URL, and SHA256 computed from the actual base parquet bytes. |
| `version` | Manifest version, or the single non-null version found in the parquet. Unknown or mixed editions without a manifest version return `null`. |
| `format` | Public parquet format from the manifest, **not** the local cache format. |
| `source_commit` | Pinned source commit recorded by the manifest. Missing metadata is `null`; it is not filled from the current checkout. |
| `status`, `accepted` | Manifest content-review/acceptance facts, separate from online availability. Missing values are `null`, not an assumption of acceptance. |
| `canonical_docs_url`, `canonical_url_status` | Manifest documentation root and its deployment-status label. Missing values are `null`; a planned URL is not proof of a live site. |
| `rows`, `rows_by_ptype` | Counts read from the union of available parts, rather than copied from a potentially outdated manifest. |
| `sources` | Per-part metadata, including resolved `source`, actual `sha256`, `bytes`, row counts and `role` (`docs`, `source`, or `corpus` for a legacy combined file). Use this to identify the file to query directly and its actual size. |
| `source_pack` | `available` states whether source is loaded; `expected` is the docs manifest's companion descriptor, or `null`; `source` is the selected companion location, or `null`. Expected rows and bytes are not loaded coverage. |
| `capabilities.full_source_bodies` | Whether source rows exist in the available parts and every source row has a non-null `body_md`. This does not certify the upstream capture's completeness. |
| `capabilities.source_symbols` | `true` when the source-symbol column is present; `null` for older artifacts without it. Presence does not mean every file or construct is supported. |
| `capabilities.evidence_graph` | `true` when link, dependency and fixture-association metadata columns are present; otherwise `null`. It does not certify that every link resolves or every claim is proved. |

No manifest means its publication fields stay unknown. Introspection is not acceptance, and it does not probe the runtime or contact the documentation site.

### Requirements and cache identity

The scripts use Python 3.8+ with its standard library, plus the `duckdb` CLI. The builder loads DuckDB's FTS extension and installs that extension if needed. Provision DuckDB and FTS in advance for offline use; the skill does not install Python or DuckDB.

`HANKWEAVE_DOCS_CACHE` defaults to `~/.hankweave/docs`. Completed database names use the `hankweave-docs` prefix and bind the canonical identities and actual SHA256 hashes of both selected files, plus the cache-format version. Adding, removing or replacing the companion changes cache identity; changing a file while preserving its timestamp still selects a new cache. Old completed generations remain available.

The builder materializes a temporary index, closes it successfully, and only then promotes it. A failed build does not replace completed generations. `build-index.sh` prints `{format,source,sha256,cache}`; here `format` is the **cache** format. `build-index.sh --path` prints only the selected database path. Normal queries ensure the index exists automatically; `info` does not use it.

## Query contracts

| Command | Result |
|---|---|
| `info` | It inspects all selected parts without a cache or FTS. `--json` emits one metadata object; see the fields above. |
| `search words…` | It scores block-sized passages and returns up to twelve parent-section hits, at most three per page. It includes the section ordinal, scope, version, document type, score, parent `chars` and a matching passage. Generated navigation and link destinations do not compete with substantive documentation. Source search covers selected stored windows, not the entire source body. |
| `term IDENTIFIER` | It returns exact, case-sensitive technical identifier occurrences across full bodies in available parts, including code outside source windows when source is loaded, and JSON paths. It is not arbitrary substring search. Results include page, anchor, scope, count, version and URL. `--scope all` interleaves available scopes. Totals count result rows, while `count` records occurrences. |
| `outline PAGE` | It returns stored sections in order, with anchors and `chars`. `outline SOURCE --at L5557 --scope source` instead returns recorded containing constructs, innermost first. |
| `read PAGE#ANCHOR` or `read PAGE ANCHOR` | It emits the stored section text without an added heading or newline. For the opening, pass `PAGE ''` or `PAGE#`. A bare page ID is not a request for the whole page: use `page`. |
| `read ID Lstart-Lend --scope source` | It emits exact inclusive source lines from the whole file. Use `--scope fixture` for text fixtures. Line endings are preserved; invalid ranges and binary descriptors fail. A single `Lstart` prefers an existing stored section, otherwise that file line. |
| `page ID` | It emits the complete stored body exactly, with no response-size limit. Binary fixture rows return their descriptor, not an invented transcription. Not-found errors direct you to ID/scope/fixture discovery. |
| `neighbors PAGE` | It returns typed evidence, dependencies and fixture relationships. `PAGE#ANCHOR` selects outgoing section evidence; `--lines L5557` or `--lines L5481-L5608` on a source/text fixture selects incoming bounded citations of that region. |
| `resolve ID-OR-URL` | It resolves IDs, slugs, canonical URLs and aliases. Historical fan-outs remain multiple results. Explicit version prefixes never substitute another edition; a mismatch preserves empty results and explains it on stderr. |
| `toc` | It lists the selected scope, including whole-page `word_count`. This is an inventory, not a reconstruction of the curated reading journey. |
| `figures PAGE` | It lists the figure's caption, kind, stored URL and verbatim Mermaid twin. |

Queries default to `--scope docs`; use `source`, `fixture` or `all` deliberately. Without source, `--scope source` returns a missing-pack error; `--scope all` searches available scopes and warns about partial coverage. Do not report that source was searched in that case. `info` always describes all available parts and the expected companion, regardless of scope. Put **all options before `--`** when passing literal arguments beginning with a dash: `term --scope all --limit 12 -- --start-new`. Everything after `--` is query text, even `--json` or `--scope`. Without the separator, options may precede or follow ordinary positional arguments.

Tabular queries accept `--json` and return arrays; `info --json` returns one object. Raw `read`/`page` text cannot be wrapped with `--json`. Both `neighbors` and `term` accept `--limit`, `--offset` and `--all`. An outgoing `neighbors --anchor` filter excludes unrelated page-wide dependencies and incoming links. An incoming `--lines` filter requires a source or text-fixture row and includes only overlapping, explicitly bounded citations. Do not combine the two directions. `outline --at` is the source-context lookup.

```bash
bash scripts/hankweave-docs.sh neighbors '<page#section>' --json
bash scripts/hankweave-docs.sh neighbors '<source ID>' --lines L5557 --scope source --json
bash scripts/hankweave-docs.sh outline '<source ID>' --at L5557 --scope source --json
bash scripts/hankweave-docs.sh term outputFiles --scope all --limit 12 --json
bash scripts/hankweave-docs.sh term outputFiles --scope all --all --json
```

Before a large read, compare whole-page `word_count` from `toc` with section `chars` from `outline` or `search`. Read one section or a bounded source/fixture line range first. Neither `read` nor `page` truncates the stored text. Prefer `--offset`/`--limit` to `--all` for large term or evidence results; exhaust the relevant scope's pages before claiming absence.

## Evidence graph and publication status

Public format 3 preserves source citations that would otherwise be lost when the publisher removes authoring scaffolding. It links visible citations and the source-backed selections supporting the page to real published file IDs and line ranges. Lines are checked against the complete source body; a valid range does not itself prove that a claim follows from it.

A source basename is resolved only when unambiguous. Exact paths are preferred. Unknown or ambiguous references remain reported rather than bound to a convenient file. Dependency labels for private or unpublished input collections can legitimately remain unresolved.

With source attached, source-citation results include a short exact preview from the stored starting line and, when recorded, the innermost symbol containing that start. The symbol does not necessarily contain the entire cited range. Neither field widens or replaces the original evidence locator. Without source, `neighbors` preserves the original target ID, URL and line bounds, reports `missing-source`, and returns a null preview rather than treating a known target as an unresolved identity. Cite it as the documentation's source reference, not as code you inspected. Syntax-derived context is available only where the publisher recorded it; unsupported or older source metadata is a limitation, not proof that a declaration does not exist.

Fixture manifests are real stored files, not generated claims that every neighboring file was exercised. Each associated fixture points to its manifest, and the manifest exposes its members. Some files have no identifiable scope manifest. Read the actual manifest for models, capture dates, normalized fields and limitations. Duplicate bytes at distinct fixture paths retain distinct identities.

Documentation URLs use `https://hankweave.southbridge.ai/<version>/files/`; see the [online-reference table](SKILL.md#online-references) for the pinned root, first-run page and separate root-level downloads. The root is an alias for the introduction at `start/introduction/`; other page IDs keep their full route, including a terminal `/index`. Explicit versions in these URLs, or in legacy `/docs/<version>/` URLs from older data, must match the selected corpus. Legacy URLs are not new aliases.

Figures have their own stored asset URLs: the general route is `https://hankweave.southbridge.ai/diagrams/<slug>/<n>.<ext>`, while a bundle may bind a figure to a content-addressed asset. Use the returned URL; never append `diagrams/` under `/files/`. GitHub repository URLs retain their pinned source commit; captured surfaces and fixture assets keep separate versioned locations.

Deployment is in progress and parity with this bundle is unverified, so `canonical_url_status` remains `planned`. The content remains unaccepted regardless of whether a route becomes available; neither acceptance nor a canonical URL proves deployment.

Older public artifacts remain readable. Their raw dependency labels are represented as unresolved when they lack stored identities. Missing graph metadata is disclosed; the index does not guess source-line relationships that an old artifact never recorded. Older root-relative figure paths retain their own page origin.

## Public parquet fields

| Fields | Meaning |
|---|---|
| `id`, `slug`, `section`, `title` | They identify the publishable unit. Source IDs begin `source/`; fixture IDs begin `fixtures/`. |
| `ptype`, `quadrant` | `ptype` separates authored/generated docs, source and fixture files. The documentation quadrant distinguishes procedures, tutorials, explanations and references; it is not a classification of source code. |
| `version`, `url`, `digest` | They identify the runtime edition, canonical location and public body. The adjacent manifest hashes the entire parquet, including metadata. |
| `body_md`, `sections` | They retain the complete canonical body and ordered `{anchor,heading,level,text}` reading sections. Source bodies are verbatim files; source sections are lookup windows, not a reconstruction recipe. |
| `aliases`, `related`, `next` | They preserve deliberate lookup alternatives and documentation navigation. |
| `links_out` | Entries retain `href,target_id,anchor,text` and add `kind,source_anchor,line_start,line_end`. `anchor` is at the destination; `source_anchor` identifies the citing section. Line bounds are inclusive and one-based. |
| `source_symbols` | Optional syntax-derived context for supported source files: `{name,kind,line_start,line_end,signature}`. Bounds describe complete constructs and are separate from the original lookup windows and evidence citations. |
| `deps` | Entries retain the declared `label` with `target_id,status,candidates`. Only `status: resolved` has an authoritative target ID; ambiguous candidates are alternatives, not asserted dependencies. |
| `fixture_role`, `fixture_manifest_id` | They identify actual manifest rows and their associated evidence. A manifest identifies itself for grouping; an unassociated file has no invented parent. |
| `diagrams` | Entries include caption/kind, exact Mermaid, planned figure URL and optional measured `display_width`. |
| `content_bytes`, `media_type`, `content_sha256` | Binary fixtures retain original bytes and metadata. Text fixtures retain the captured text. |

## Search full bodies without a large response

A source `search` miss only rules out a hit in the selected scoring windows. `term` covers available full-body technical identifiers, but arbitrary phrases or substrings require direct SQL over `body_md`. Attach source and confirm its availability first; querying the core parquet alone cannot search source bodies. No FTS index is needed:

```bash
bash scripts/hankweave-docs.sh info --json
duckdb :memory: -bail -c "SELECT id, url, word_count,
  length(body_md) AS chars, count(*) OVER () AS matching_files,
  substr(body_md, greatest(1, strpos(lower(body_md), lower('checkpoint')) - 80), 320) AS excerpt
FROM read_parquet('/absolute/path/to/hankweave-source-0.10.0.parquet')
WHERE ptype = 'source' AND contains(lower(body_md), lower('checkpoint'))
ORDER BY id LIMIT 12 OFFSET 0;"
```

Use the source part's local `source` path from `info.sources`, keeping the same selected edition. For a legacy combined parquet, use its base `source` path. Replace the literal and path safely: SQL strings escape a single quote as two single quotes; do not interpolate unescaped user input. This query scans each selected source file's complete text but returns at most twelve short excerpts, one per matching file, with the total matching-file count. Increase `OFFSET` by twelve to cover the remaining files. The excerpt shows the first occurrence only; it is navigation, not every match or a complete code explanation.

For documentation, query the docs part with `ptype NOT IN ('source', 'fixture')`; for fixtures, query the docs part with `ptype = 'fixture'`. A binary fixture's `body_md` is only its descriptor, not full-text coverage of the original binary. To inspect a known file with the helper, use `outline ID --scope source` and exact line reads, or `page ID --scope source` when its size is appropriate. Do not dump all `body_md` values or a whole transcript bundle into a response.

## Local DuckDB tables

The cache keeps binary payloads in the parquet, not in its search tables.

- `pages` retains public reading/graph fields, adds `scope`, and renames `section` to `site_section`.
- `chunks` retains complete stored sections, including `page`, `ord`, `anchor`, `heading`, `text`, `chars`, `scope`, `version` and `url`.
- `search_chunks` contains separate scoring passages with unique `subchunk_id`, `parent_id`, `page`, `ord`, `sub_ord`, `anchor`, raw `text`, scoring `search_text`, sizes and `oversized`. A fence, table or numbered step is not cut apart merely to meet the target size.
- `terms(term,page,anchor,scope,count)` supports exact identifiers. Full-body indexing avoids missing source regions outside declaration windows or double-counting overlapping windows.
- `graph_edges` exposes `source_id`, `target_id`, `kind`, `label`, `href`, destination `anchor`, `source_anchor`, line bounds, resolution `status` and `candidates`.
- `source_symbols(page,name,kind,line_start,line_end,signature)` supports containing-construct lookup without guessing from nearby 40-line windows.
- `source_identity` records the selected parts and their content/cache-format identity.

Find the cache path with `build-index.sh --path`. Example direct queries:

```sql
SELECT t.scope, t.page, t.anchor, t.count, p.version, p.url
FROM terms t JOIN pages p ON p.id = t.page
WHERE t.term = 'rollback.toLastSuccess'
ORDER BY t.scope, t.page, t.anchor;

SELECT e.kind, e.label, e.target_id, e.line_start, e.line_end, p.url
FROM graph_edges e LEFT JOIN pages p ON p.id = e.target_id
WHERE e.source_id = 'operate/resume-rollback-and-retry'
  AND e.kind = 'source-citation';

SELECT p.id, d.label, d.target_id, d.status
FROM pages p, UNNEST(p.deps) AS dependency(d)
WHERE p.id = 'reference/hank-json';
```

Raw section text can retain an HTML alias at a boundary. It is navigation syntax from the stored document, not a missing section or a new instruction. The reader deliberately does not strip it or rewrite the canonical text.

Quote SQL strings by doubling single quotes. Do not interpolate unescaped user text or file paths. The CLI handles quoting itself. When edition or publication status matters to the answer, use `info` and preserve known mismatches, unknowns and review/planned status; direct SQL does not establish acceptance or deployment.
