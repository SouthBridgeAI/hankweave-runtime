1. Remove the tadpoleserver integration.
Let's remove this for now if it's mentioned, since we can do this later.

#### 2. Centralize Chronicler Unloading Logic

The plan suggests handling `ChroniclerFatalError` in `processEvent`. This is good, but what if a fatal error occurs during a `flush()` operation at the end of a phase? The current plan doesn't account for that.

**Improvement:**
Centralize the error handling within `ChroniclerManager` to make it more robust.

```typescript
// In server/chroniclers/chronicler-manager.ts

// Wrap event handling
public async handleEvent(event: ServerEvent): Promise<void> {
  const promises = this.chroniclers.map(chronicler =>
    this._safelyExecute(chronicler.getId(), () => chronicler.handleEvent(event))
  );
  await Promise.allSettled(promises);
}

// Wrap flush handling
public async flush(): Promise<void> {
  const promises = this.chroniclers.map(chronicler =>
    this._safelyExecute(chronicler.getId(), () => chronicler.flush())
  );
  await Promise.allSettled(promises);
}

// Centralized error-handling wrapper
private async _safelyExecute(chroniclerId: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ChroniclerFatalError && error.shouldUnload) {
      this.logger?.log(
        `Unloading chronicler ${error.chroniclerId} due to fatal error: ${error.message}`,
        'error'
      );
      this.unloadChronicler(chroniclerId); // New unload method
    } else {
      this.logger?.log(
        `Error in chronicler ${chroniclerId}: ${error}`,
        'error'
      );
    }
  }
}

// New unload method
private unloadChronicler(chroniclerId: string): void {
  const chronicler = this.chroniclers.find(c => c.getId() === chroniclerId);
  if (chronicler) {
    chronicler.destroy(); // Clean up timers etc.
    this.chroniclers = this.chroniclers.filter(c => c.getId() !== chroniclerId);
    this.logger?.log(`Unloaded chronicler ${chroniclerId}.`, 'info');
  }
}
```
This makes the manager more resilient by ensuring any fatal error, regardless of when it occurs, results in the chronicler being safely unloaded.

#### 3. Clarify `model` Configuration in `chronicler.schema.ts`

The existing `chroniclerConfigSchema` in `server/config-validation/chronicler.schema.ts` has `model: z.enum(["sonnet", "opus"]).optional()`. This needs to be updated to accept the full model IDs that the `LlmProviderRegistry` expects (e.g., `"anthropic/claude-3-5-sonnet-20241022"`).

**Improvement:**
Update the schema to accept a generic string and add a comment clarifying the expected format.

```typescript
// In server/config-validation/chronicler.schema.ts

export const chroniclerConfigSchema = z.object({
  // ... other fields
  model: z.string().optional().describe(
    'The full model ID to use (e.g., "anthropic/claude-3-5-sonnet-20241022"). ' +
    'If not provided, a default model will be used.'
  ),
  // ... rest of schema
});
```

#### 4. Address Health Check Timing

The plan correctly suggests running health checks in the background. However, it's worth noting the implication: if a chronicler is loaded for a provider whose health check is still pending (or has failed), `isModelAvailable` will return `false`, and the chronicler will be skipped. This is the correct, fail-safe behavior, but it would be good to log a specific message for this case.

**Improvement:**
In `ChroniclerManager.loadChroniclersForPhase`, add a more specific log message.

```typescript
// In ChroniclerManager.loadChroniclersForPhase
const isAvailable = this.providerRegistry.isModelAvailable(config.model);
const providerStatus = this.providerRegistry.getProviderStatus().get(providerId);

if (!isAvailable) {
  let reason = "provider not configured or model not found";
  if (providerStatus?.status === 'available' && !providerStatus.healthy) {
    reason = `provider '${providerId}' is not healthy`;
  }
  this.logger?.log(
    `Skipping chronicler ${config.id}: Model ${config.model} not available because ${reason}.`,
    'warn'
  );
  continue;
}
```