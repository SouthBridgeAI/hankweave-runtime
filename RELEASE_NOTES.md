## [0.7.4] - 2026-07-03

### Added
- GLM models (`glm-5.2`, `zai/glm-5.2`, …) are automatically routed through the pi shim's native Z.AI provider (`pi/zai/<id>`, authenticated via `ZAI_API_KEY`). The pi shim now recognizes the `zai` credential

### Changed
- Zhipu AI (`zhipuai`) is now the preferred/canonical provider for GLM models in the registry (`zai`/`Z.AI` is its international brand), so a bare `glm-*` id resolves deterministically to `zhipuai/...` instead of to whichever reseller happens to load last in the models.dev data. Runtime execution still routes through the pi shim's `zai` provider, since the pi SDK has no `zhipuai` provider
- Updated model data — refreshed `models-dev-data.json` from models.dev (147 providers, 5,109 models). Adds `anthropic/claude-sonnet-5` (Claude Sonnet 5, released 2026-06-30), now the most-recent Anthropic Sonnet, so the `sonnet` shortcut and fuzzy matches resolve to it instead of `claude-sonnet-4-6`. Also drops the upstream-removed `claude-3-5-haiku-20241022`/`claude-3-5-haiku-latest` aliases. Updated `llm-provider-registry` unit test expectations accordingly
- Updated `@openai/codex-sdk` to 0.142.4 (root and codex shim) and rebuilt the codex shim
- Updated `@earendil-works/pi-coding-agent` to 0.80.3

### Fixed
-