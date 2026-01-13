# ENG-91: Config Warnings on Resume - Related Code

## Current Resume Logic (`server/index.ts` & `execution-setup.ts`)

**execution-setup.ts lines 102-122: Resume detection**
```typescript
const metaPath = path.join(executionPath, '.hankweave', 'execution-meta.json');
if (fs.existsSync(metaPath)) {
  // Verify data hash matches
  const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
  if (meta.dataHash !== dataHash) {
    throw new Error(
      `Data source mismatch. Execution directory was created for different data.`
    );
  }
  isResuming = true;
}
```

**What's checked**: Only data hash is validated on resume.

**What's NOT checked**: Hank configuration changes!

## Config Loading (`server/index.ts` lines 249-265)

```typescript
const absoluteConfigPath = path.isAbsolute(configPath)
  ? configPath
  : path.resolve(originalCwd, configPath);

const cliArgs = parseCliArgs(args);
const resolvedConfig = resolveSettings({
  cliArgs,
  hankPath: absoluteConfigPath,
});
```

**No comparison with previous config** - always loads fresh from file.

## What Needs to be Added

### 1. Store Config Snapshot on First Run

**Location**: `.hankweave/execution-meta.json`

**Add fields**:
```typescript
interface ExecutionMeta {
  version: string;
  readOnlySourceDataPath: string;
  dataHash: string;
  createdAt: string;
  lastUsed: string;
  // NEW:
  hankConfig?: {
    path: string;           // Original hank.json path
    hash: string;           // SHA-256 of hank.json content
    codonCount: number;     // Quick validation check
    codonIds: string[];     // List of codon IDs
  };
}
```

### 2. Compare on Resume

**In server/index.ts before validation**:
```typescript
if (executionSetup.isResuming) {
  const meta = JSON.parse(
    fs.readFileSync(path.join(executionSetup.executionPath, '.hankweave', 'execution-meta.json'), 'utf-8')
  );

  if (meta.hankConfig) {
    const currentHankContent = fs.readFileSync(absoluteConfigPath, 'utf-8');
    const currentHash = crypto.createHash('sha256').update(currentHankContent).digest('hex');

    if (meta.hankConfig.hash !== currentHash) {
      console.warn(`\n⚠️  WARNING: Hank configuration has changed since this execution was created!\n`);
      console.warn(`  Original: ${meta.hankConfig.path}`);
      console.warn(`  Original codons: ${meta.hankConfig.codonCount}`);
      console.warn(`  Current codons: ${/* need to load to know */}\n`);
      console.warn(`  This may cause unexpected behavior when resuming.\n`);

      // Optionally prompt user to confirm
      if (!skipConfirmation) {
        const readline = require('readline').createInterface({
          input: process.stdin,
          output: process.stdout
        });

        const answer = await new Promise<string>(resolve => {
          readline.question('Continue anyway? [y/N] ', resolve);
        });
        readline.close();

        if (answer.toLowerCase() !== 'y') {
          process.exit(1);
        }
      }
    }
  }
}
```

## Files to Modify

1. **server/execution-setup.ts** (lines 204-223): Add hankConfig to meta
2. **server/index.ts** (after line 248): Add resume warning logic
3. **server/types/types.ts**: Update ExecutionMeta type (if exists)

## Summary

Simple check: compare current hank.json hash with stored hash. If different, warn loudly. Low complexity (~100 lines).
