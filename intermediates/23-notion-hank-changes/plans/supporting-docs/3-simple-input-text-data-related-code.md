# ENG-93: Support Simple Text Input as Data - Related Code Analysis

## Current Implementation (`server/execution-setup.ts`)

**Lines 43-46: Data source validation**
```typescript
const stats = await fs.promises.stat(readOnlySourceDataPath);
if (!stats.isDirectory() && !stats.isFile()) {
  throw new Error(`Data source is not a file or directory: ${readOnlySourceDataPath}`);
}
```
**Already supports both files and directories!**

**Lines 166-197: File handling logic**
```typescript
if (stats.isDirectory()) {
  // Existing directory logic (symlink or copy)
} else if (stats.isFile()) {
  // File logic (already implemented!)
  await fs.promises.mkdir(dataPathInExecutionDir, { recursive: true });
  const destFilePath = path.join(dataPathInExecutionDir, path.basename(readOnlySourceDataPath));

  if (useSymlink) {
    await fs.promises.symlink(readOnlySourceDataPath, destFilePath);
  } else {
    await fs.promises.copyFile(readOnlySourceDataPath, destFilePath);
  }
}
```

**Key finding**: File support ALREADY EXISTS in the code!

## What's Missing

Looking at the Linear task, the issue is about creating text input on the fly, not just passing file paths.

**Example from task description**:
```bash
# User wants this:
echo "Analyze this text" | hankweave --data=-
# Or:
hankweave --data-text="Analyze this specific text"
```

## stdin Support Pattern

**Need to detect stdin** (`--data=-` convention):
```typescript
// In server/index.ts
const dataSourcePath = args.find(arg => arg.startsWith('--data='))?.split('=')[1];

if (dataSourcePath === '-') {
  // Read from stdin
  const stdinContent = await readStdin();
  // Create temporary file
  const tempFile = path.join(os.tmpdir(), `hankweave-stdin-${Date.now()}.txt`);
  await fs.promises.writeFile(tempFile, stdinContent);
  dataSourcePath = tempFile;
}
```

## Inline Text Support

**New flag**: `--data-text` for inline text:
```typescript
const dataText = args.find(arg => arg.startsWith('--data-text='))?.split('=')[1];
if (dataText) {
  // Create temporary file
  const tempFile = path.join(os.tmpdir(), `hankweave-text-${Date.now()}.txt`);
  await fs.promises.writeFile(tempFile, dataText);
  dataSourcePath = tempFile;
}
```

## Summary

- File support EXISTS (lines 179-196 of execution-setup.ts)
- stdin support MISSING (need to add `--data=-` detection)
- Inline text support MISSING (need to add `--data-text` flag)
- Both require creating temporary files, then using existing file handling logic
