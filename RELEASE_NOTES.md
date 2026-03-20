## [0.6.2] - 2026-03-19

### Added

- **Exported public types and schemas** — `server/exports/types.ts` and `server/exports/schemas.ts` expose a stable set of runtime types and Zod schemas for use by external consumers. A dedicated `tsconfig.exports.json` and updated build script generate the exports bundle.

### Changed

- **Updated model data** — Refreshed `models-dev-data.json` with latest provider model entries (March 2026). (ENG-225)
- **Codex shim API key logic consolidated** — `resolvedApiKey`, `apiKeySource`, and `isAuthConfigured` are now readonly getters on `CodexShim`, replacing scattered utility functions. Key priority order is explicit and tested: `OPENAI_API_KEY` > `CODEX_API_KEY` > `~/.codex/auth.json`. Unit and integration tests cover all priority combinations.

### Fixed

- **Codex shim falls back to SDK bundled binary when `codex` not on PATH** — `resolveCodexPath()` previously called `writeStartupError` if `which codex` failed, blocking the SDK's own `findCodexPath()` from running. In CI, codex is not on PATH but is available via npm platform packages. Now passes `null` to the Codex constructor so it can resolve the binary itself; self-test also tries `tryFindSdkBundledCodex()` as a fallback.
- **Codex shim `WebSearch` defers `tool_use` emission until `item.completed`** — WebSearch items arrive with `query: ""` at `item.started`; the real query only appears in later streaming chunks. Deferring emission ensures transcript logs record a non-empty query.
- **Codex warnings no longer thrown as errors** — The shim previously threw on any non-fatal warning message from Codex, causing spurious failures. Warnings are now logged and ignored.
- **Codon failure classification reads `msg.result` instead of `msg.error`** — `ResultMessage` has no `error` field; error text lives in `msg.result`. Reading `msg.error` always yielded `undefined`, so every error result was classified as `{ type: "unknown", retriable: false }`, including retriable timeouts and rate-limit errors.
- **Loop codons funded via hank proportional shares now route correctly** — When a hank used proportional allocation with a named share for a loop but the loop had no explicit `budget` field, `loopContext.loopBudget` was `undefined`. The routing condition fell through to `resolveHankScopedLimits`, which looked up shares by codon ID instead of loop ID, yielding a $0 allocation. Now synthesizes an implicit `loopBudget: {}` so the correct loop-scoped path is taken.