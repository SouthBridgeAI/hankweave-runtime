# Usage

The shim reads the prompt from stdin.

```bash
echo "Say hello" | ./index.js --model composer-2.5-fast
```

Resume:

```bash
echo "What did I ask earlier?" | ./index.js --model composer-2.5-fast --resume <session-uuid>
```

## Flags

- `--model` (required for a real run; `MODEL` is the fallback)
- `-p` accepted and ignored; stdin is always read
- `--resume`
- `--append-system-prompt`
- `--debug-dir`
- `--idle-timeout` (seconds, default 120)
- `--verbose`
- `--sandbox` accepted and ignored
- `--self-test`, `--version`, `--help`

Unknown flags are ignored.
