We are going to iterate on the original design outlined in intermediates/20-detect-context-exceeded/1-prompt.md. In case where tadpole server is not using llm proxy, we need to be able to support error context exceeded error by parsing claude log. Below are examples of how these errors look like inside claude log:

```json
{"type":"assistant","message":{"id":"92543df9-1a77-4605-bec0-3cea4ce9f51f","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0},"service_tier":null},"content":[{"type":"text","text":"API Error: terminated"}]},"parent_tool_use_id":null,"session_id":"983b8c3c-7336-4ef9-8d38-f564e81f551e"}
```

```json
{"type":"result","subtype":"success","is_error":true,"duration_ms":370393,"duration_api_ms":371414,"num_turns":18,"result":"API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.","session_id":"89273bda-141c-4842-ba54-96d1eab913a0","total_cost_usd":0.7717817000000001,"usage":{"input_tokens":6,"cache_creation_input_tokens":71382,"cache_read_input_tokens":75580,"output_tokens":32008,"server_tool_use":{"web_search_requests":0},"service_tier":"standard"}}
```

The approach we should take as follows:

- introduce a helper similar to isSyntheticTimeout called isContextExceeded
- integrate it inside tadpole server in the same way (we only want to use is when llm proxy is not enabled to prevent handling the same error twice)
- for now handle it by just logging the error
- update any relevant tests

Provide a detailed implementation plan for this extension, include relevant code snippets