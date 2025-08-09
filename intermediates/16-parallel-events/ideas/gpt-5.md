You already have almost everything needed to bolt on parallel LLM “listeners” with good ergonomics:

- A typed, append-only internal event bus (TypedEventEmitter) the server emits on every outbound ServerEvent and every state transition
- A durable event log (events.jsonl) in .tadpole that can be replayed (event sourcing)
- Per-phase/run lifecycle and context, so we can scope observations
- File-resolver and trackedFiles semantics, so “what the agent touched” is available
- A clear place to write additional artifacts under .tadpole

What we add is a sidecar subsystem that subscribes to that event stream, filters/batches, and fans out parallel LLM calls to produce:
- extracted facts/indices,
- evaluations/health checks,
- narrative summaries,
- redacted streams for different audiences.

Naming: the concept and the roles
- Umbrella concept: Observers (boring) or Watchers (MCU nod: The Watcher / Uatu). I’d use Watchers.
- Role types under Watchers (optional taxonomy you can reflect in UX):
  - Scribe: extraction/indexing (facts, files, entities)
  - Sentinel: evaluation/QA/guardrails (was this a wrong turn, risky tool use, etc.)
  - Herald: narration for humans (what’s happening), potentially streaming
  - Redactor: audience-specific filters/transformers for the activity stream
This mirrors your needs 1–4 and helps users quickly pick “the kind” they want.

High-level architecture
- WatcherManager lives in the server process. It subscribes to:
  - server.emit("event", ServerEvent) for low-latency real-time,
  - optionally stateManager.on("stateChanged", …) for transitions that aren’t in the WS stream,
  - optionally tails .tadpole/events.jsonl for replay/catch-up on resume.
- Each Watcher is defined by a config (like phases.json) that tells it:
  - what to listen for (event types, tool names, file globs, phase ids),
  - how to batch (window by time, count, or phase boundary),
  - which files to read/include when triggering,
  - how to prompt (system/prompt file/text),
  - which model/provider to call (via AI SDK),
  - whether to keep per-watcher chat history,
  - what output format (text or object with a schema),
  - where to write (a watcher-specific jsonl under .tadpole/watchers/), and/or whether to stream to clients,
  - optional transforms/redactions to apply to upstream events before they hit clients (audience filters).

Concurrency and isolation
- Watchers run in parallel to core phase execution; they MUST NOT be able to block, fail, or mutate the core flow.
- Bound concurrency and token budgets per Watcher.
- Cancel/flush pending jobs on phase end or shutdown.
- Treat model errors as non-fatal; log in watcher outputs.

Event-sourcing as a core pattern
- Treat the canonical stream as the ServerEvent stream and/or .tadpole/events.jsonl.
- Watchers are projections: they keep their own durable offsets (last processed event id + timestamp) and derived state. On resume, they can rebuild by replaying the event log.
- This gives you determinism, idempotence, and testability: unit-test a watcher by feeding a fixture of events.

Proposed config: watchers.json
- Lives next to phases.json (or a watchers key can be embedded in phases.json if you prefer one file).
- Watchers are independent of phases but can scope to phases.

Example watchers.json

[
  {
    "id": "files-index",
    "name": "Touched files index",
    "type": "scribe",
    "triggers": {
      "events": ["assistant.action", "tool.result", "file.updated"],
      "toolNames": ["Read", "Write", "Edit", "MultiEdit", "LS", "Glob"],
      "fileGlobs": ["**/*"],                // further filter on file paths seen in events
      "phases": ["*"],                      // or explicit ["phase-1", "phase-2"]
      "debounceMs": 750,                    // batch window to coalesce bursts
      "maxBatch": 200
    },
    "includeFiles": {
      "fromEventPaths": true,               // read small files mentioned in events
      "maxBytes": 32768,                    // cap reads
      "allowBinary": false
    },
    "prompt": {
      "systemFile": "watchers/prompts/files-index.system.md",
      "userFile": "watchers/prompts/files-index.user.md"
    },
    "model": "openai/gpt-4.1-mini",
    "history": false,                       // stateless per batch
    "output": {
      "format": "object",
      "jsonSchemaFile": "watchers/schemas/files-index.schema.json",
      "path": ".tadpole/watchers/files-index.jsonl"
    }
  },
  {
    "id": "loop-quality",
    "name": "Agent loop quality rater",
    "type": "sentinel",
    "triggers": {
      "events": ["assistant.action", "tool.result", "error"],
      "rate": "every-n-actions",
      "n": 25
    },
    "prompt": {
      "systemFile": "watchers/prompts/quality.system.md",
      "userFile": "watchers/prompts/quality.user.md"
    },
    "model": "anthropic/claude-3-7-sonnet",
    "history": true,                        // keep watcher-local chat memory within token cap
    "output": {
      "format": "object",
      "zodSchemaFile": "watchers/schemas/quality.zod.ts",
      "path": ".tadpole/watchers/quality.jsonl"
    },
    "actions": {
      "emitEventOnBadScore": true,          // emits observer.event to clients
      "threshold": 0.4
    }
  },
  {
    "id": "narration",
    "name": "Human-readable narration",
    "type": "herald",
    "triggers": {
      "events": ["assistant.action", "tool.result", "token.usage"],
      "timeSlicerMs": 2000                  // summarize last 2s of activity
    },
    "prompt": {
      "systemText": "You convert low-level agent actions into a concise timeline for humans."
    },
    "model": "openai/gpt-4o-mini",
    "history": true,
    "stream": {
      "enabled": true,
      "toClient": true,                     // stream deltas to UI
      "smooth": true
    },
    "output": {
      "format": "text",
      "path": ".tadpole/watchers/narration.jsonl"
    }
  },
  {
    "id": "public-log",
    "name": "Public redacted log",
    "type": "redactor",
    "filters": {
      "removeToolInputs": ["Bash"],         // or scrub inputs
      "maskPathsUnder": ["read_only_data_source/**"],
      "dropEvents": ["token.usage"],        // e.g., reduce noise
      "replacePatterns": [
        { "pattern": "(?<=API_KEY=)[A-Za-z0-9_-]+", "with": "****" }
      ]
    },
    "stream": {
      "enabled": true,
      "as": "observer.redactedEvent"        // event name to clients
    },
    "output": {
      "format": "text",
      "path": ".tadpole/watchers/public-log.ndjson"
    }
  }
]

Notes:
- model string maps to AI SDK provider id (you can support your own mapping table later).
- prompt supports systemFile/systemText and userFile/userText (like phases).
- output.format is: text | object. When object:
  - schema via zod file or JSON Schema file. Under the hood we’ll feed zod or JSON Schema to generateObject/streamObject.
- triggers supports different modes:
  - events: array of ServerEvent.type to subscribe to,
  - toolNames filter,
  - fileGlobs filter applied to paths in events,
  - rate/time windows, debounce, maxBatch
  - scope by phases/runs
- includeFiles toggles careful file-content sampling when a file path appears in an event.
- stream.toClient: Watcher can stream deltas as it gets tokens from the model.

TypeScript interfaces (scaffold)

export type WatcherRole = 'scribe' | 'sentinel' | 'herald' | 'redactor';

export interface WatcherConfig {
  id: string;
  name: string;
  type: WatcherRole;
  triggers: {
    events: Array<import('./types/types.js').ServerEvent['type']>;
    toolNames?: string[];
    fileGlobs?: string[];
    phases?: string[]; // '*' or explicit list
    debounceMs?: number;
    maxBatch?: number;
    rate?: 'every-n-actions' | 'time';
    n?: number;
    timeSlicerMs?: number;
  };
  includeFiles?: {
    fromEventPaths?: boolean;
    maxBytes?: number;
    allowBinary?: boolean;
  };
  prompt?: {
    systemFile?: string | string[];
    systemText?: string;
    userFile?: string | string[];
    userText?: string;
  };
  model: string; // ai sdk provider id like 'openai/gpt-4.1', 'anthropic/claude-3-7-sonnet'
  history?: boolean; // watcher-local
  stream?: {
    enabled: boolean;
    toClient?: boolean;
    as?: 'observer.stream' | 'observer.redactedEvent' | string;
    smooth?: boolean;
  };
  output: {
    format: 'text' | 'object';
    path: string; // jsonl or ndjson
    jsonSchemaFile?: string;
    zodSchemaFile?: string;
  };
  actions?: {
    emitEventOnBadScore?: boolean;
    threshold?: number;
  };
  filters?: {
    removeToolInputs?: string[];
    maskPathsUnder?: string[];
    dropEvents?: Array<import('./types/types.js').ServerEvent['type']>;
    replacePatterns?: Array<{ pattern: string; with: string }>;
  };
}

Plumbing plan: new modules
1) server/watcher-manager.ts
- Loads watchers.json (zod validates it like phases).
- Holds a set of Watcher instances; each holds internal buffer, timer, and offset.
- Subscribes to TadpoleServer’s TypedEventEmitter (“event”).
- For each event:
  - Runs redaction filters first for Redactor watchers (transform stage).
  - For other watchers, runs trigger filter -> add to batch; based on window/rate it fires an LLM job.
- Manages a concurrency pool (e.g., p-limit) with config defaults:
  - maxConcurrentJobs global, per-watcher override
  - cancels outstanding jobs when the phase completes, depending on watcher semantics (configurable).
- Writes outputs to watcher-specific jsonl files under .tadpole/watchers/<watcher-id>.jsonl.
- Maintains watcher offsets (last processed event id + ts) in .tadpole/watchers/state.json so it can replay after restart by tailing events.jsonl until that point.

1) server/watcher-llm.ts
- A tiny adapter around AI SDK Core:
  - resolve model string to ai sdk model
  - build prompt: system + user text concatenations + baton content from events/files (we’ll propose a helper)
  - for format 'object':
    - if zod schema available (compiled TypeScript), import it dynamically and use generateObject/streamObject
    - if JSON Schema, use generateObject({ schema: jsonSchema }) with ai-sdk’s JSON schema support
  - for format 'text':
    - generateText/streamText with optional smoothing transform
  - capture usage for the watcher (optional; watcher's cost is not currently tracked by your costs model, but you can add a separate ledger if you want).

1) server/watcher-prompting.ts
- Helpers to convert a batch of ServerEvent[] into compact prompt chunks:
  - compact representation of assistant.action (thinking/messages summarized to N chars)
  - include tool name, truncated input/result
  - timestamps and phase id
  - optional included files (only small text, size gate)
  - configurable token budget trimming (we can pre-count chars/bytes as proxy)

1) Optional: server/event-transform-pipeline.ts
- A pipeline that can be injected into TadpoleServer.sendEvent(event) to apply configured Redactor filters before sending to clients or to route redacted streams as separate observer events.
- Think of it as “audiences”: default audience (full), public audience (redacted). Initially we can just create separate “observer.redactedEvent” for the TUI/other clients to subscribe to.

Minimal code scaffolding

// server/watcher-manager.ts
import fs from 'node:fs';
import path from 'node:path';
import { TypedEventEmitter } from './typed-event-emitter.js';
import type { ServerEvent } from './types/types.js';
import type { WatcherConfig } from './types/watcher-types.js';
import pLimit from 'p-limit';
import micromatch from 'micromatch';

export class WatcherManager {
  private watchers: Watcher[] = [];
  private limit = pLimit(4); // default global concurrency

  constructor(
    private executionPath: string,
    private tadpoleDir: string,
    private emitter: TypedEventEmitter<{ event: [ServerEvent] }>,
    watcherConfigs: WatcherConfig[],
  ) {
    this.watchers = watcherConfigs.map(cfg => new Watcher(cfg, executionPath, tadpoleDir, this.limit));
  }

  start(): void {
    this.emitter.on('event', (ev) => {
      for (const w of this.watchers) {
        w.onEvent(ev);
      }
    });
  }

  stop(): void {
    for (const w of this.watchers) w.dispose();
  }
}

class Watcher {
  private buffer: ServerEvent[] = [];
  private timer?: NodeJS.Timeout;
  private out: fs.WriteStream;

  constructor(
    private config: WatcherConfig,
    private executionPath: string,
    private tadpoleDir: string,
    private limit: <T>(fn: () => Promise<T>) => Promise<T>,
  ) {
    const outPath = path.isAbsolute(config.output.path)
      ? config.output.path
      : path.join(executionPath, config.output.path);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    this.out = fs.createWriteStream(outPath, { flags: 'a' });
  }

  onEvent(ev: ServerEvent): void {
    if (!this.matches(ev)) return;
    this.buffer.push(ev);

    const { debounceMs, maxBatch, rate, n, timeSlicerMs } = this.config.triggers || {};
    if (rate === 'every-n-actions' && n && this.buffer.length >= n) {
      this.fire();
      return;
    }
    if (maxBatch && this.buffer.length >= maxBatch) {
      this.fire();
      return;
    }
    if (timeSlicerMs) {
      // summarize every time window
      if (!this.timer) this.timer = setTimeout(() => this.fire(), timeSlicerMs);
      return;
    }
    if (debounceMs) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.fire(), debounceMs);
      return;
    }
    // default: fire immediately on each match
    if (!debounceMs && !maxBatch && !rate && !timeSlicerMs) {
      this.fire();
    }
  }

  private matches(ev: ServerEvent): boolean {
    const t = this.config.triggers;
    if (!t?.events?.includes(ev.type)) return false;

    // tool filters
    if ('data' in ev && ev.type === 'assistant.action' && ev.data.action === 'tool_use') {
      if (t.toolNames && !t.toolNames.includes(ev.data.toolName || '')) return false;
    }
    if (ev.type === 'tool.result') {
      if (t.toolNames && !t.toolNames.includes(ev.data.toolName)) return false;
    }

    // file globs: inspect typical file fields
    if (t.fileGlobs && t.fileGlobs.length) {
      const paths: string[] = [];
      if (ev.type === 'file.updated') paths.push(ev.data.path);
      // Tool inputs often have file_path, add if present:
      if (ev.type === 'assistant.action' && ev.data.toolInput) {
        const maybePath = (ev.data.toolInput as any).file_path;
        if (typeof maybePath === 'string') paths.push(maybePath);
      }
      if (paths.length && !paths.some(p => micromatch.isMatch(p, t.fileGlobs!))) {
        return false;
      }
    }

    // phase filter
    if (t.phases && !t.phases.includes('*')) {
      const evPhase = 'data' in ev && (ev.data as any).phaseId;
      if (evPhase && !t.phases.includes(evPhase)) return false;
    }

    return true;
  }

  private async fire(): Promise<void> {
    const batch = this.buffer;
    this.buffer = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (batch.length === 0) return;

    // Enqueue LLM job
    await this.limit(async () => {
      try {
        const result = await runWatcherLLM(this.config, batch, this.executionPath);
        // Write jsonl or text
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          watcherId: this.config.id,
          result
        });
        this.out.write(line + '\n');
        // Optional: stream to clients (emit as observer.* event) – integrate by passing an emitter
      } catch (e) {
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          watcherId: this.config.id,
          error: String(e)
        });
        this.out.write(line + '\n');
      }
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.out.end();
  }
}

// server/watcher-llm.ts
import { generateText, generateObject, streamText, streamObject } from 'ai';
import { smoothStream } from 'ai';
import { z } from 'zod';
import fs from 'node:fs';

export async function runWatcherLLM(config: WatcherConfig, events: ServerEvent[], executionPath: string) {
  const { prompt } = config;
  const system = [
    ...(await readAll(prompt?.systemFile)),
    prompt?.systemText || ''
  ].filter(Boolean).join('\n\n');

  const user = [
    ...(await readAll(prompt?.userFile)),
    buildEventPayload(events, config, executionPath)
  ].filter(Boolean).join('\n\n');

  if (config.output.format === 'object') {
    const schema = await loadSchema(config, executionPath);
    // AI SDK supports zod or JSON schema
    const { object } = await generateObject({
      model: config.model,
      schema,
      prompt: user,
      system
    });
    return object;
  } else {
    const { text } = await generateText({
      model: config.model,
      prompt: user,
      system
    });
    return { text };
  }
}

async function readAll(f?: string | string[]) {
  if (!f) return [];
  const files = Array.isArray(f) ? f : [f];
  return Promise.all(files.map(async p => fs.readFileSync(p, 'utf-8')));
}

async function loadSchema(config: WatcherConfig, executionPath: string) {
  if (config.output.zodSchemaFile) {
    const modPath = path.isAbsolute(config.output.zodSchemaFile)
      ? config.output.zodSchemaFile
      : path.join(executionPath, config.output.zodSchemaFile);
    const mod = await import(modPath);
    return mod.default || mod.schema || mod;
  }
  if (config.output.jsonSchemaFile) {
    const full = path.isAbsolute(config.output.jsonSchemaFile)
      ? config.output.jsonSchemaFile
      : path.join(executionPath, config.output.jsonSchemaFile);
    return JSON.parse(fs.readFileSync(full, 'utf-8'));
  }
  // Fallback generic shape:
  return z.object({ summary: z.string(), items: z.array(z.unknown()).optional() });
}

function buildEventPayload(events: ServerEvent[], config: WatcherConfig, executionPath: string) {
  // Create a compact textual payload. You can improve with token budgeting.
  const lines: string[] = [];
  for (const ev of events) {
    lines.push(`[${ev.timestamp}] ${ev.type} ${short(ev)}`);
  }
  return [
    'BEGIN_AGENT_ACTIVITY',
    lines.join('\n'),
    'END_AGENT_ACTIVITY'
  ].join('\n');
}

function short(ev: ServerEvent): string {
  switch (ev.type) {
    case 'assistant.action':
      if (ev.data.action === 'message') return `assistant: ${ell(ev.data.content, 200)}`;
      if (ev.data.action === 'thinking') return `thinking: ${ell(stripNL(ev.data.content), 200)}`;
      if (ev.data.action === 'tool_use') return `tool_use ${ev.data.toolName} input=${ell(JSON.stringify(ev.data.toolInput), 200)}`;
      return '';
    case 'tool.result':
      return `tool_result ${ev.data.toolName} len=${ev.data.originalLength} ms=${ev.data.executionTimeMs} error=${!!ev.data.isError}`;
    case 'file.updated':
      return `file ${ev.data.action} ${ev.data.path} (${ev.data.content.length} chars)`;
    case 'token.usage':
      return `usage in=${ev.data.inputTokens} out=${ev.data.outputTokens} cost=${ev.data.totalCost.toFixed(4)}`;
    case 'phase.started':
      return `phase.started ${ev.data.phaseId}`;
    case 'phase.completed':
      return `phase.completed ${ev.data.phaseId} success=${ev.data.success} cost=${ev.data.cost.toFixed(4)}`;
    default:
      return '';
  }
}
function ell(s: string, n: number) { return s.length > n ? s.slice(0, n) + '…' : s; }
function stripNL(s: string) { return s.replace(/\s+/g, ' '); }

Hook points in existing code
- Create and start the manager in TadpoleServer constructor after setupStateManagerListeners:

// tadpole-server.ts (constructor or start)
import { WatcherManager } from './watcher-manager.js';
import { loadWatcherConfig } from './watcher-config.js';

private watcherManager?: WatcherManager;

async start(): Promise<void> {
  ...
  const watchers = await loadWatcherConfig(absoluteConfigPath.replace('phases.json', 'watchers.json'));
  this.watcherManager = new WatcherManager(
    this.config.executionPath,
    path.join(this.config.executionPath, '.tadpole'),
    this, // the TadpoleServer is a TypedEventEmitter of ServerInternalEvents with 'event'
    watchers
  );
  this.watcherManager.start();
  ...
}

- Ensure you call this.emit("event", event) — you already do that inside sendEvent; the WatcherManager can subscribe to that.

- On shutdown, stop the watcher manager to flush and close streams.

Streaming to clients (optional in v1)
- Define new event types in server/types/types.ts for watcher streaming:
  - observer.stream: id, timestamp, data: { watcherId, phaseId?, deltaText?, partialObject?, final?: boolean }
  - observer.event (for redacted log lines): id, timestamp, data: { watcherId, payload }
- Wire Watcher to optionally emit these via TadpoleServer.sendEvent().

Configuration loader and validation
- Copy the approach in server/config.ts (zod) for watchers.json:
  - Resolve prompt file paths relative to config file.
  - Validate model strings and existence of files.
  - Provide helpful error messages akin to your phases validation.

Data layout
- .tadpole/watchers/
  - files-index.jsonl
  - quality.jsonl
  - narration.jsonl
  - state.json (per watcher offsets, e.g. { files-index: { lastTs, lastEventId }, ... })

Privacy and safety
- Redactor watchers don’t call an LLM; they transform events. Keep them in-process.
- For Scribe/Sentinel/Herald watchers that call external models, be explicit in config about what payload fields can be exported (e.g., includeFiles: max size, block binaries).
- Consider “allowlist audiences” if you add per-audience outbound streams.

Token and cost control
- Watchers use LLM too. You may want a separate cost tally (not mixed with phase costs). Initially, write usage metadata into watcher jsonl lines. Later, sum them under a new ledger .tadpole/watchers/usage.json.
- Max concurrency and per-watcher budgets to avoid interfering with core agent.

Batched prompting patterns
- Encourage watchers to request structured outputs for reliability using AI SDK’s generateObject or streamObject.
- For narration (Herald), streamText with smoothStream() is a good pattern (AI SDK built-in).

A few ready-made watchers to ship first
1) Scribe: files-index
- Extracts a deduplicated, timestamped index of files that were read/written/edited, by which tool, with sizes, and a “where in phase” index.
- Schema:
  {
    file: string,
    action: 'read' | 'write' | 'edit' | 'create' | 'delete' | 'list',
    tool: string,
    phaseId: string,
    at: string
  }

2) Sentinel: loop-quality
- Rates last N actions for “lostness,” repetitive tool calls, reading huge files without narrowing, etc. Emits score 0..1, label, and suggested corrective hint.
- If score below threshold, emit an info or error event (non-fatal) so UIs can flag.

3) Herald: narration
- Every 2s, produce a near-real-time narration sentence or bullet list; stream to clients.
- Persist it to jsonl for later “playback” timeline.

4) Redactor: public-log
- A transform pipeline that creates a sanitized log line per event; can be used to power a “public stream” UI.

Patterns and concerns
- Backpressure: batch windows and max concurrency protect the core process. Watchers must never await inside TadpoleServer.sendEvent; they are entirely decoupled.
- Cancellation: on phase.completed/failed/skipped, watchers should flush and then optionally reset state/history (configurable: scope='phase' | 'run' | 'global').
- Replay: if a watcher state suggests it fell behind (server restart), it can replay .tadpole/events.jsonl until its last offset, then rejoin real-time.
- Idempotency: include event id and timestamp in your watcher outputs; if replaying, dedupe on a compound key.
- Token budget: pre-trim payloads; summarize content server-side if large. Be careful reading files automatically; size caps are mandatory.
- Security: Redactor pipelines run before sending to clients, but you may want default-safe behavior (e.g., drop Bash tool inputs unless explicitly allowed).
- Model/provider abstraction: use AI SDK model string now; later you can inject provider factories. You already pass env vars with TADPOLE_ into Claude; do similarly for watchers if needed.

Why this fits your codebase
- It keeps state changes append-only and side-effect free; watchers are projections over your existing event log. This aligns with event-sourcing.
- The code additions are localized: a manager, a small LLM adapter, and optional event types.
- The TUI can render new observer.* events easily.

Example: files-index Scribe prompt (watchers/prompts/files-index.user.md)

You will receive a short textual transcript of recent agent events (tool uses, file updates).
Extract a list of unique file activities as JSON objects with fields:
- file: normalized relative path from the execution root
- action: one of ["read","write","edit","create","delete","list"]
- tool: tool name
- phaseId: phase id if present
- at: ISO timestamp (use the event timestamp)
Only include entries that contain a file path. Do not invent paths.

BEGIN
{{EVENTS}}
END

Example: quality schema (watchers/schemas/quality.zod.ts)

import { z } from 'zod';
export const schema = z.object({
  score: z.number().min(0).max(1),
  label: z.enum(['ok','drift','stuck','risky']),
  reasons: z.array(z.string()).max(5),
  recommendations: z.array(z.string()).max(5),
  window: z.object({
    actionsAnalyzed: z.number(),
    from: z.string(),
    to: z.string(),
  })
});
export default schema;

UI integration
- In Basic TUI, add new cases:
  - observer.stream: print incremental text
  - observer.redactedEvent: print line
  - observer.completed: show structured result summary
- Because Watchers are orthogonal to phases, the TUI can toggle “watcher views”.

Roadmap
Milestone 1
- WatcherManager, minimal Scribe watcher (files-index), object output to jsonl, no streaming.
- Load watchers.json; validate with zod; start/stop with server.

Milestone 2
- Herald watcher with streamText and observer.stream events; TUI print stream.

Milestone 3
- Redactor pipeline and public log; add an option in TadpoleServer to broadcast redacted events to client.

Milestone 4
- Sentinel evaluation with thresholds that emits info/error events; per-watcher cost ledger.

Milestone 5
- Replay capability from events.jsonl and durable offsets.

Optional nice-to-haves
- Per-watcher “scope”: reset history on phase boundary vs. run vs. global.
- Per-model safety/masking (no PII leakage) in watcher prompting.
- A tiny DSL for triggers (e.g., when toolName in [Write, Edit] and path matches “**/secrets/**” then evaluate risk).

Final thoughts on naming
- “Watchers” as the feature, with types Scribe, Sentinel, Herald, Redactor is simple and memorable.
- If you want MCU: Watchers with “Uatu-class” for system-wide omniscience; “Heimdall” for the redactor (gatekeeper of what passes); fun but maybe less clear.

This design stays faithful to your event-driven, append-only architecture and leverages the AI SDK cleanly:
- generateObject/streamObject for structured outputs,
- generateText/streamText (with smoothStream) for narration,
- transformations and streaming are opt-in per watcher,
- nothing blocks or mutates the core loop.

Happy to provide a PR stub with watcher-manager.ts, types, and a starter files-index watcher if you want to iterate from there.