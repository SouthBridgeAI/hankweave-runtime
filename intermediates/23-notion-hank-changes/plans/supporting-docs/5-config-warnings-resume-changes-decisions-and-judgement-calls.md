# ENG-91: Config Warnings on Resume - Changes and Decisions

## Step 2 Agent Analysis

Currently, only data hash is verified on resume. Hank config can change silently, causing confusing behavior.

## Decision 1: What to Store

**Minimal approach**: Just SHA-256 hash of hank.json content.

**Research validation:**
SHA-256 is the industry standard for configuration change detection. [Network equipment uses SHA-256 for config checksums](https://arubanetworking.hpe.com/techdocs/AOS-CX/10.14/HTML/fundamentals_8400/Content/Chp_Cfg_FW_mgt/Chk_cmds/sho-run-cfg-hash.htm) to detect modifications. [Hash comparison tools](https://offlinetools.org/tools/file-hash-compare) rely on comparing current hash with cached versions. SHA-256 provides strong collision resistance (practically impossible to have two different configs with same hash) while remaining fast to compute.

**Enhanced approach**: Hash + metadata (codon count, IDs) for better warnings.

**Recommendation**: Enhanced approach - helps user understand what changed.

## Decision 2: When to Warn

**Always warn** if hash differs, regardless of what changed. Users should be aware.

**Warning levels**:
- **WARN**: Config changed (non-blocking)
- **ERROR**: Incompatible change (e.g., current codon doesn't exist anymore)

## Decision 3: Prompt Behavior

**With `-y` flag**: Skip prompt, log warning and continue
**Without `-y` flag**: Prompt user to confirm

**Recommendation**: Make this configurable via env var too:
- `HANKWEAVE_IGNORE_CONFIG_CHANGES=true` to auto-continue

## Implementation Complexity

**Low**: ~150 lines
- Meta storage: ~30 lines
- Hash comparison: ~20 lines
- Warning display: ~40 lines
- User prompt: ~30 lines
- Tests: ~30 lines

**Total**: Half day of work

## Step 2 Agent Recommendation

Implement this - it prevents user confusion when resuming old executions with modified configs.
