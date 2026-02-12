import { expect, test } from "bun:test";
import * as fs from "node:fs";

interface TelemetryDebugEvent {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

interface TestState {
  telemetryJsonlPath?: string;
}

function readTelemetryJsonl(jsonlPath: string): TelemetryDebugEvent[] {
  if (!fs.existsSync(jsonlPath)) {
    return [];
  }
  const content = fs.readFileSync(jsonlPath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TelemetryDebugEvent);
}

function findTelemetryEvents(
  events: TelemetryDebugEvent[],
  eventName: string,
): TelemetryDebugEvent[] {
  return events.filter((e) => e.event === eventName);
}

export function runTelemetryVerificationTests(testState: TestState) {
  let events: TelemetryDebugEvent[] = [];

  // Load events once, lazily
  function getEvents(): TelemetryDebugEvent[] {
    if (events.length === 0 && testState.telemetryJsonlPath) {
      events = readTelemetryJsonl(testState.telemetryJsonlPath);
    }
    return events;
  }

  // ---------------------------------------------------------------------------
  // JSONL file exists and has events
  // ---------------------------------------------------------------------------

  test("telemetry debug JSONL file was created", () => {
    expect(testState.telemetryJsonlPath).toBeDefined();
    const allEvents = getEvents();
    expect(allEvents.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Common fields on all events
  // ---------------------------------------------------------------------------

  test("all events have schema_version and user properties", () => {
    for (const evt of getEvents()) {
      expect(evt.properties.schema_version).toBe(1);
      const $set = evt.properties.$set as Record<string, unknown> | undefined;
      expect($set).toBeDefined();
      expect($set?.hankweave_version).toBeDefined();
      expect($set?.os).toBeDefined();
      expect($set?.arch).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // CLI events
  // ---------------------------------------------------------------------------

  test("cli_run event is present with flags", () => {
    const cliRun = findTelemetryEvents(getEvents(), "cli_run");
    expect(cliRun.length).toBe(1);
    expect(cliRun[0].properties.flags).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Run lifecycle
  // ---------------------------------------------------------------------------

  test("run_started event has hank structure and providers", () => {
    const runStarted = findTelemetryEvents(getEvents(), "run_started");
    expect(runStarted.length).toBe(1);

    const props = runStarted[0].properties;
    expect(props.run_id_hash).toBeDefined();
    expect(typeof props.run_id_hash).toBe("string");

    // Hank structure
    const hank = props.hank as Record<string, unknown>;
    expect(hank).toBeDefined();
    const summary = hank.summary as Record<string, unknown>;
    expect(summary.total_codons).toBe(3);

    // Providers
    expect(props.providers).toBeDefined();
    expect(Array.isArray(props.providers)).toBe(true);
  });

  test("run_completed event has metrics and duration", () => {
    const runCompleted = findTelemetryEvents(getEvents(), "run_completed");
    expect(runCompleted.length).toBe(1);

    const props = runCompleted[0].properties;
    expect(props.duration_ms).toBeDefined();
    expect(props.duration_bucket).toBeDefined();
    expect(props.total_cost_usd).toBeDefined();

    // Run metrics
    const run = props.run as Record<string, unknown>;
    expect(run).toBeDefined();
    const metrics = run.metrics as Record<string, unknown>;
    expect(metrics.total_codons).toBe(3);
    expect(metrics.codons_completed).toBe(3);
    expect(metrics.codons_failed).toBe(0);

    // Tool usage
    const tools = props.tools as Record<string, unknown>;
    expect(tools).toBeDefined();
    expect(typeof tools.total_calls).toBe("number");
  });

  test("no run_failed or run_crashed events in happy path", () => {
    expect(findTelemetryEvents(getEvents(), "run_failed").length).toBe(0);
    expect(findTelemetryEvents(getEvents(), "run_crashed").length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Codon lifecycle
  // ---------------------------------------------------------------------------

  test("3 codon_started events with run and codon hashes", () => {
    const codonStarted = findTelemetryEvents(getEvents(), "codon_started");
    expect(codonStarted.length).toBe(3);

    for (const evt of codonStarted) {
      expect(evt.properties.run_id_hash).toBeDefined();
      expect(evt.properties.codon_id_hash).toBeDefined();
      expect(typeof evt.properties.run_id_hash).toBe("string");
      expect(typeof evt.properties.codon_id_hash).toBe("string");
    }
  });

  test("3 codon_completed events with metrics", () => {
    const codonCompleted = findTelemetryEvents(getEvents(), "codon_completed");
    expect(codonCompleted.length).toBe(3);

    for (const evt of codonCompleted) {
      expect(evt.properties.run_id_hash).toBeDefined();
      expect(evt.properties.codon_id_hash).toBeDefined();
      expect(typeof evt.properties.duration_ms).toBe("number");
      expect(typeof evt.properties.cost_usd).toBe("number");
      expect(Array.isArray(evt.properties.tools_used)).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // LLM Analytics ($ai_generation, $ai_trace)
  // ---------------------------------------------------------------------------

  test("at least 3 $ai_generation events with model and token info", () => {
    const aiGen = findTelemetryEvents(getEvents(), "$ai_generation");
    expect(aiGen.length).toBeGreaterThanOrEqual(3);

    for (const evt of aiGen) {
      expect(evt.properties.$ai_trace_id).toBeDefined();
      expect(evt.properties.$ai_span_id).toBeDefined();
      expect(evt.properties.$ai_model).toBeDefined();
      expect(typeof evt.properties.$ai_input_tokens).toBe("number");
      expect(typeof evt.properties.$ai_output_tokens).toBe("number");
    }
  });

  test("$ai_trace event for the full run", () => {
    const aiTrace = findTelemetryEvents(getEvents(), "$ai_trace");
    expect(aiTrace.length).toBe(1);

    const props = aiTrace[0].properties;
    expect(props.$ai_trace_id).toBeDefined();
    expect(typeof props.$ai_latency).toBe("number");
    expect(props.$ai_is_error).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  test("at least 1 checkpoint_created event", () => {
    const checkpoints = findTelemetryEvents(getEvents(), "checkpoint_created");
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);

    for (const evt of checkpoints) {
      expect(evt.properties.run_id_hash).toBeDefined();
      expect(evt.properties.codon_id_hash).toBeDefined();
      expect(evt.properties.checkpoint_type).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // Rig setup lifecycle
  // ---------------------------------------------------------------------------

  test("at least 1 rig_setup_completed event", () => {
    const rigCompleted = findTelemetryEvents(getEvents(), "rig_setup_completed");
    expect(rigCompleted.length).toBeGreaterThanOrEqual(1);

    for (const evt of rigCompleted) {
      expect(evt.properties.run_id_hash).toBeDefined();
      expect(evt.properties.codon_id_hash).toBeDefined();
      expect(typeof evt.properties.command_count).toBe("number");
      expect(typeof evt.properties.duration_ms).toBe("number");
      expect(typeof evt.properties.created_checkpoint).toBe("boolean");
    }
  });

  test("rig_setup_failed events are emitted with correct schema", () => {
    const rigFailed = findTelemetryEvents(getEvents(), "rig_setup_failed");
    expect(rigFailed.length).toBeGreaterThan(1);

    for (const evt of rigFailed) {
      expect(evt.properties.run_id_hash).toBeDefined();
      expect(evt.properties.codon_id_hash).toBeDefined();
      expect(typeof evt.properties.failure_type).toBe("string");
      expect(typeof evt.properties.ignored).toBe("boolean");
      expect(evt.properties.ignored).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Sentinels (may or may not fire — validate schema if present)
  // ---------------------------------------------------------------------------

  test("sentinel_triggered events have correct schema if present", () => {
    const sentinels = findTelemetryEvents(getEvents(), "sentinel_triggered");
    for (const evt of sentinels) {
      expect(evt.properties.run_id_hash).toBeDefined();
      expect(evt.properties.codon_id_hash).toBeDefined();
      expect(typeof evt.properties.sentinel_index).toBe("number");
      expect(typeof evt.properties.trigger_count).toBe("number");
    }
  });

  // ---------------------------------------------------------------------------
  // Privacy: no raw codon IDs leak
  // ---------------------------------------------------------------------------

  test("raw codon IDs do not appear in telemetry properties", () => {
    const rawCodonIds = ["codon-1", "codon-2", "codon-3"];
    const allEventsJson = JSON.stringify(getEvents().map((e) => e.properties));

    for (const id of rawCodonIds) {
      expect(allEventsJson).not.toContain(`"${id}"`);
    }
  });

  // ---------------------------------------------------------------------------
  // Event ordering
  // ---------------------------------------------------------------------------

  test("events appear in logical order: cli_run -> run_started -> codons -> run_completed -> $ai_trace", () => {
    const allEvents = getEvents();
    const eventNames = allEvents.map((e) => e.event);

    const cliRunIdx = eventNames.indexOf("cli_run");
    const runStartedIdx = eventNames.indexOf("run_started");
    const firstCodonStarted = eventNames.indexOf("codon_started");
    const runCompletedIdx = eventNames.indexOf("run_completed");
    const aiTraceIdx = eventNames.indexOf("$ai_trace");

    // cli_run is sent immediately (separate from the batch), so it appears first
    expect(cliRunIdx).toBeLessThan(runStartedIdx);
    // run_started before first codon
    expect(runStartedIdx).toBeLessThan(firstCodonStarted);
    // codons before run_completed
    expect(firstCodonStarted).toBeLessThan(runCompletedIdx);
    // run_completed before $ai_trace
    expect(runCompletedIdx).toBeLessThan(aiTraceIdx);
  });
}
