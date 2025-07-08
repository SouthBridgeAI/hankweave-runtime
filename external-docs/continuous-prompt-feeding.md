Based on the documentation, **yes, you can keep feeding prompts while Claude is running through stdin**, but only when using a specific streaming mode.

Here's what the docs say about this capability:

## Streaming JSON Input

The SDK supports a **streaming JSON input** mode that allows you to:

1. **Send multiple turns without relaunching** - "This allows multiple turns of a conversation without re-launching the `claude` binary"
2. **Provide guidance while processing** - "allows providing guidance to the model while it is processing a request"

### Requirements:

- Must use `-p` (print mode)
- Must use `--output-format stream-json`
- Must use `--input-format=stream-json`
- Messages must be in JSONL format (one JSON object per line)

### Example:

```bash
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Explain this code"}]}}' | claude -p --output-format=stream-json --input-format=stream-json --verbose
```

### Limitations:

- Currently limited to text-only user messages
- Each message must follow the specific JSON schema format

## Default Behavior

In the default text input mode, stdin is only read at startup - you cannot continue feeding prompts after Claude starts processing.

So in summary: continuous stdin feeding is supported, but only with the streaming JSON mode enabled with the proper flags.
