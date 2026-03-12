# Implementation Notes

This file preserves the high-value working notes from the original build process.

## Key takeaways

- Gemini `stream-json` is sufficient for primary control flow, but not sufficient by itself for faithful tool-result content.
- Native Gemini tool ids are not protocol-valid shim tool ids, so public id remapping is mandatory.
- Gemini resume by explicit UUID works in practice and is worth using directly.
- A subprocess integration is simpler and more robust here than a deeper in-process Gemini integration.

## Important resolved issues

- Feeding Gemini via stdin improved resume behavior compared with relying on `--prompt`.
- A small built-in internal instruction prefix reduced spurious delegation and improved memory-style prompts.
- Tracking the child process exit promise immediately avoided a real bug where Node could otherwise fall off the event loop before exit handling completed.
- Additional internal guidance improved reliability on long ordered tasks and machine-readable file generation.
- Public model output now consistently uses `google/...` form even when callers pass bare model names or short aliases.
- Timeout handling now uses an adaptive idle/busy split and is covered by local regression tests.
- JSON repair continuations required an explicit control-flow flag so follow-up prompts would not be lost in the post-exit path.

## Open constraints worth remembering

- Gemini `stream-json` is sparse; timeout logic must be based on observable activity rather than assumptions about richer lifecycle events.
- The shim intentionally does not create its own session folders unless `--debug-dir` is provided.
- A mixed `google/gemini-2.5-pro` eval batch showed some load sensitivity at the outer eval-suite level, even though isolated reruns passed.

## Historical references from the original work log

- latest confirmed full green eval run in the workspace materials: `packages/eval-suite/runs/2026-03-09T17-00-28-index`
- isolated target-model passes noted in the workspace materials:
  - `packages/eval-suite/runs/2026-03-09T16-47-33-index`
  - `packages/eval-suite/runs/2026-03-09T16-58-46-index`
