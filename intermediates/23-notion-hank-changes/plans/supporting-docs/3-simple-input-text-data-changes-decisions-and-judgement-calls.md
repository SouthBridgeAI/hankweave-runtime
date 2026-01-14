# ENG-93: Simple Text Input as Data - Changes and Decisions

## Step 2 Agent Analysis

**Surprising discovery**: File support already exists! The execution-setup.ts code (lines 179-196) handles files perfectly. What's missing is creating files from stdin or inline text.

## Decision 1: stdin Support via `--data=-`

**Convention**: Use `-` to mean stdin (Unix standard)

**Historical validation from research:**
The hyphen convention for stdin has [deep Unix roots dating to Ken Thompson in Version 5 Unix](https://www.baeldung.com/linux/dash-in-command-line-parameters), when he modified `sort` to accept "-" for standard input. This spread throughout Unix tools and became so standard that [many commands automatically treat "-" as stdin/stdout](https://linuxvox.com/blog/what-s-the-magic-of-a-dash-in-command-line-parameters/). It's equivalent to using `/dev/stdin` but more ergonomic.
```bash
echo "Analyze this" | hankweave hank.json -
# Or with flag:
echo "Analyze this" | hankweave --config hank.json --data=-
```

**Implementation**: Create temp file from stdin, then use existing file handling:
```typescript
if (dataSourcePath === '-') {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks).toString('utf-8');

  const tempFile = path.join(os.tmpdir(), `hankweave-stdin-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await fs.promises.writeFile(tempFile, content);
  dataSourcePath = tempFile;
}
```

## Decision 2: Inline Text via `--data-text`

**New flag** for inline text without creating files manually:
```bash
hankweave hank.json --data-text="Analyze this specific text"
```

**Precedence**: `--data-text` overrides `--data` and positional args:
- If `--data-text` provided, use it
- Else if `--data` provided, use it
- Else use positional arg or default

## Decision 3: Temporary File Management

**Temp file creation**:
- Use `os.tmpdir()` for cross-platform support
- Include timestamp + random suffix for uniqueness
- Extension: `.txt` for text data

**Cleanup**: Temp files are in OS temp directory - they'll be cleaned up by OS eventually. Don't need explicit cleanup since execution is short-lived.

## Complexity Assessment

**Implementation**: Low (50-80 lines)
- stdin reading: ~20 lines
- `--data-text` handling: ~15 lines
- Temp file creation: ~10 lines
- Validation updates: ~20 lines
- Help text: ~10 lines

**Total**: 2-3 hours of work

## Step 2 Agent Recommendation

This is a small feature that significantly improves UX for quick experiments. Implement it!
