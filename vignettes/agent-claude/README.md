# Auth

```
claude setup-token
```

Grab the token and set it as:

```
CLAUDE_CODE_OAUTH_TOKEN=...
```

# Note on Claude code binary bundling

It looks like the ts module ships with the complete claude code bundled inside of it via `cli.js`. All the Claude calls get forwarded to it.
