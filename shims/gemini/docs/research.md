# Research

## Summary

- Target agent: Gemini CLI (`gemini`) version `0.27.0`
- Required model targets from the project materials:
  - `google/gemini-2.5-flash`
  - `google/gemini-2.5-pro`
- Chosen integration strategy: spawn the installed Gemini CLI in headless `--output-format stream-json` mode and translate its event stream into shim JSONL
- Supplemental data source: Gemini native session files under `~/.gemini/tmp/**/chats/session-*.json`
- Additional runtime safeguard: validate JSON files touched during the turn and, when needed, resume the same Gemini session to repair invalid machine-readable files before reporting success

## Sources consulted

1. `read_only_data_source/gemini-cli.txt`
2. `gemini --help`
3. `gemini --version`
4. Installed Gemini CLI docs/source under the local npm installation
5. Eval-suite source in `packages/eval-suite`

## Findings

### Gemini CLI headless interface

- `gemini -p/--prompt` exists, but feeding the prompt through stdin matched session-resume behavior more reliably during testing
- `--output-format stream-json` emits JSONL events suitable for shim translation
- Installed Gemini ACP support did not look like a good fit for the required resume semantics in this project

### Observed stream-json event shapes

Observed event families:

- `init`
- `message`
- `tool_use`
- `tool_result`
- `error`
- `result`

### Session behavior

- Gemini native session ids are UUIDs
- Resume by explicit UUID works in practice, even though `gemini --help` emphasizes `latest` and numeric shortcuts
- Native session files live under paths like `~/.gemini/tmp/<project-hash>/chats/session-*.json`

### Tool-result fidelity gap

Direct testing showed that `stream-json` tool results can be empty or less informative than the corresponding data in Gemini's native session files. Native session files often preserve richer fields such as:

- `functionResponse.response.output`
- `resultDisplay`
- diff metadata for edits/writes

Conclusion: the shim should enrich tool results from the native session file when stream output is empty.

### Tool name normalization

Relevant Gemini-native tool names observed during eval-style workflows:

- `read_file`
- `write_file`
- `replace`
- `run_shell_command`
- `glob`
- `search_file_content`
- `list_directory`

These map cleanly onto the shim standard tool names.

### Sandbox mapping

Implemented mapping:

- `none` -> `GEMINI_SANDBOX=false`
- `standard` -> `--sandbox`
- `strict` -> `--sandbox` plus `SEATBELT_PROFILE=restrictive-open` on macOS

### Authentication observations

Gemini authentication in this environment could be detected either from environment variables or Gemini's local settings file.

## Failure modes reproduced during validation

### Silent success turn

Gemini sometimes emitted:

- `init`
- maybe a user echo
- `result.success`

...with no assistant text, tool use, or tool results.

The shim now treats that as a provider quirk and resumes the same session once with a continuation prompt.

### Numbered-step truncation

Gemini sometimes stopped after early numbered steps in ordered tasks and skipped later requested file operations.

The shim now issues one completion-check follow-up for numbered task lists that appear incomplete.

### Invalid JSON output

Real-agent runs, especially on `google/gemini-2.5-pro`, occasionally left JSON files syntactically invalid even when the turn otherwise looked successful.

The shim now:

1. tracks JSON files touched by `Write` and `Edit`
2. parses the on-disk files before reporting success
3. resumes the same Gemini session with a repair prompt when needed
4. allows a bounded second repair attempt because first-pass repairs sometimes over-escaped JSON

## Validation summary

- full `gemini-2.5-flash` eval-suite run: `36/36` passed
- explicit targeted `google/gemini-2.5-pro` probes also passed for key workflows
