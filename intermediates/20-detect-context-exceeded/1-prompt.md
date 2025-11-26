We need a way to detect "Context Exceeded" error and allow for a customized way to handle it withing tadpole server. Currently the most consistent way to detect it seems to be via LLMProxy that has access to original error messages from Claude's API server. 

Here are a few example of error messages reported:

```json
[ERROR] [PROXY-HTTP-TRANSPORT] error: {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 142778 + 64000 > 200000, decrease input length or `max_tokens` and try again"},"request_id":"req_011CUzgMtQukQG5c6M3BCwzY"} }
```

```json
[ERROR] [PROXY-HTTP-TRANSPORT] error: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 209335 tokens > 200000 maximum"},"request_id":"req_011CUzrJhQTRJaFygPAZJQdi"} }
```

Your job is to come up with a detailed execution plan (include code snippets where needed) to implement the following features:

- extend LLMProxy and any relevant classes to detect errors like the ones above and report them via callback function (please create a special error class called ContextExceededError, include original error information in it)
- add tests for LLMProxy to test this new functionality
- in tadpole server, add a handler to the llm proxy instance that is uses and log ContextExceededError to the console for now 
