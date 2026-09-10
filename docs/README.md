# Hankweave docs for agents

This directory contains the installable `hankweave-docs` runtime-reference skill and its optional source pack. It works independently of the broader `hank-in-the-shell` workflow skill. The human website and documentation-generation work live separately.

```text
docs/
├── hankweave-docs/
│   ├── SKILL.md
│   ├── reference.md
│   ├── code-map.md
│   ├── scripts/
│   └── data/
│       ├── hankweave-docs-0.10.0.parquet
│       └── hankweave-docs-0.10.0.manifest.json
└── source/
    ├── hankweave-source-0.10.0.parquet
    └── hankweave-source-0.10.0.manifest.json
```

The core parquet is approximately **1.92 MB**: 70 documentation pages and 553 fixture/evidence records. The source parquet is approximately **10.51 MB**: 693 source and captured-schema records. Each has its own checksum manifest; the docs manifest also identifies the exact matching source pack. The split does not remove content.

The [online-reference table](hankweave-docs/SKILL.md#online-references) links to the pinned documentation and the repository's parquet files with their matching manifests. Human pages use `https://hankweave.southbridge.ai/0.10.0/files/`; parquet downloads are pinned to the repository commit containing this edition.

## Install the core skill

Install from the repository subpath:

```sh
npx skills add SouthBridgeAI/hankweave-runtime/docs/hankweave-docs --skill hankweave-docs -g
```

Omit `-g` for a project installation. From a local checkout, run:

```sh
npx skills add ./docs/hankweave-docs --skill hankweave-docs -g
```

A repository install may clone repository content before copying the selected skill. The installed core does not include the optional source pack.

After installing from a tracked upstream source, update only this skill with `npx skills update hankweave-docs -g` (or `-p` for a project installation). If runtime and docs versions differ, update, reread `info`, and deliberately select older matching docs when appropriate. Do not silently treat a newer manual as the old runtime's contract.

## Read docs or inspect source

Local lookup requires Python 3.8+ and the DuckDB CLI; see the [setup guide](hankweave-docs/SKILL.md#setup). When those dependencies cannot be made available, the [hosted fallback](hankweave-docs/reference.md#hosted-fallback) offers documentation-only search and reads over HTTP. It is slower, makes more network requests and logs query/identity metadata; it does not search source or fixtures. Neither lookup path runs the Hankweave runtime.

```sh
bash docs/hankweave-docs/scripts/hankweave-docs.sh info
bash docs/hankweave-docs/scripts/hankweave-docs.sh search checkpoint rollback resume
```

In a full repository checkout, the helper finds the matching local sibling `docs/source/` automatically. A copied/installed core skill does not include that sibling. Source is never downloaded automatically. Attach a separately downloaded source file explicitly:

```sh
bash docs/hankweave-docs/scripts/hankweave-docs.sh info --source-parquet /path/to/hankweave-source-0.10.0.parquet
```

Set `HANKWEAVE_SOURCE_PARQUET` for repeated source queries. Without source, documentation and fixtures still work; source citations retain their identifiers, URLs and bounds, but their bodies/previews are unavailable. `--scope source` reports the missing pack, and `--scope all` warns about partial coverage. See the skill reference for sizes, selection, cache behavior and bounded full-body SQL.

## Publish and update

Keep one current reviewed payload here. Package the core directory as `hankweave-docs-skill-0.10.0.tar.gz` and offer the two parquet/manifest pairs as separate release downloads from the same bytes. Do not commit the generated archives as another editable copy. The runtime's npm package does not need to include these files.

For a new runtime release, either prepare and check its matching docs in release CI or explicitly omit the new release's current docs until they are ready. Do not present the previous corpus as matching new code. Preserve historical docs for their original runtime. A staging-and-publish step avoids deleting working downloads before the replacement is ready.

The `.gitattributes` entry marks parquet files binary; it is not Git LFS, compression or an access rule. It prevents text line-ending conversion and text-style merges from changing the files' bytes.
