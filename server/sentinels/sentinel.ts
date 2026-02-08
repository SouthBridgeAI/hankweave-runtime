import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ServerEvent } from "../schemas/event-schemas.js";
import { type CodonId, EventId } from "../types/branded-types.js";
import type {
  HankweaveGenerateObjectOptions,
  HankweaveGenerateObjectResult,
  HankweaveGenerateTextOptions,
  HankweaveGenerateTextResult,
} from "../types/llm-call-types.js";
import type {
  QueuedTrigger,
  SentinelConfig,
  SentinelOutputPaths,
  StructuredOutputContext,
} from "../types/sentinel-types.js";
import { generateId, type Logger, renameWithRetrySync } from "../utils.js";
import "../../tests/types/global-test-types.js";
import { HistoryManager } from "./history-manager.js";
import { type TemplateContext, TemplateRenderer } from "./prompt-templating-engine.js";
import { mergeWithDefaults } from "./sentinel-defaults.js";
import { SentinelFatalError } from "./sentinel-fatal-error.js";
import type { TriggerEngine } from "./trigger-engine.js";
import { createTriggerEngine } from "./trigger-engine.js";

/**
 * Represents a single running Sentinel instance.
 *
 * A Sentinel is a parallel observation agent that watches the event stream from
 * the main Hankweave workflow and performs its own analysis, summarization, or data
 * extraction. Key characteristics:
 *
 * - **Event-Driven**: Reacts to events based on configured triggers
 * - **Non-Blocking**: Runs in parallel, never blocks main workflow
 * - **Stateful or Stateless**: Can maintain conversation history or process events independently
 * - **Fault-Tolerant**: Errors don't crash main workflow
 *
 * Execution Strategies:
 * - immediate: Execute on every trigger match
 * - debounce: Wait for quiet period, then batch execute
 * - count: Execute after N triggers
 * - timeWindow: Execute at fixed intervals
 *
 * Initialization Pattern: Synchronous constructor only
 * Rationale: All setup is in-memory. Prompt files read synchronously for fail-fast
 * behavior. Relies on SentinelManager to initialize shared resources first.
 *
 * @example
 * const sentinel = new Sentinel(
 *   config,
 *   codonId,
 *   llmCallFn,
 *   logger,
 *   sentinelDir
 * );
 *
 * await sentinel.handleEvent(event);
 * await sentinel.flush();  // Before shutdown
 * sentinel.destroy();      // Cleanup
 */
export class Sentinel {
  private triggerEngine: TriggerEngine;

  // Queue infrastructure
  private triggerQueue: QueuedTrigger[] = [];
  private isProcessingQueue = false;
  private queueProcessingPromise?: Promise<void>;
  private readonly MAX_QUEUE_SIZE = 100;

  // Strategy-specific buffering
  private pendingEvents: ServerEvent[] = [];
  private pendingDebounce?: {
    events: ServerEvent[];
    timer: Timer;
  };
  private timeWindowTimer?: Timer;
  private lastWindowTime?: number;
  private readonly MAX_BUFFER_SIZE = 10000;

  // Core sentinel state
  private readonly historyManager?: HistoryManager; // Optional, only for conversational
  private readonly userPromptTemplate: string;
  private readonly systemPromptTemplate: string | undefined;
  private readonly runStartTime: Date;
  private readonly llmParams: {
    temperature: number;
    maxOutputTokens: number;
    maxRetries: number;
  };
  private totalCost: number = 0; // Track cumulative costs for this sentinel
  private modelCost?: { input: number; output: number }; // Cost per million tokens
  private readonly structuredOutputContext?: StructuredOutputContext; // For structured output mode
  private readonly outputPaths: {
    continuousLog: string;
    currentValue: string | undefined;
    joinString: string;
  };

  private triggerNumber: number = 0; // Sequence counter for triggers
  private llmCallCount: number = 0; // Successful LLM calls
  private failedLLMCallsCount: number = 0; // Failed LLM calls
  private lastLlmCallAt?: Date; // Timestamp of last LLM call

  constructor(
    private config: SentinelConfig,
    private codonId: CodonId,
    private llmCall: (
      id: string,
      options: HankweaveGenerateTextOptions,
    ) => Promise<HankweaveGenerateTextResult>,
    private logger?: Logger,
    sentinelDir?: string, // Optional - passed from parent for persistence
    configDirectory?: string, // For resolving relative prompt file paths
    runStartTime?: Date, // Start time of the current run
    private onExecute?: (id: string, events: ServerEvent[]) => void,
    modelCost?: { input: number; output: number }, // Optional cost per million tokens
    private llmObjectCall?: (
      id: string,
      options: HankweaveGenerateObjectOptions,
    ) => Promise<HankweaveGenerateObjectResult<unknown>>, // Optional - for structured output
    private executionPath?: string, // For path resolution
    private agentRootPath?: string, // For sentinel output path resolution with explicit paths
    outputPaths?: SentinelOutputPaths, // From codon config (optional - will auto-generate)
    private sendEventToServer?: (
      event: import("../schemas/event-schemas.js").SentinelEvent,
    ) => void, // Callback to emit events to server event stream
  ) {
    this.modelCost = modelCost;
    this.runStartTime = runStartTime || new Date();

    this.llmParams = mergeWithDefaults(this.config.llmParams);
    this.triggerEngine = createTriggerEngine(config.trigger, logger);

    // Load structured output schema if configured
    if (config.structuredOutput) {
      this.structuredOutputContext = this.loadStructuredOutputSchema(configDirectory);

      // Validate we have llmObjectCall if needed
      if (this.structuredOutputContext && !llmObjectCall) {
        throw new SentinelFatalError(
          config.id,
          "Structured output requires llmObjectCall to be provided",
          "configuration",
          true,
        );
      }

      this.logger?.log(
        `[Sentinel:${config.id}] Loaded structured output: mode=${this.structuredOutputContext.output}`,
        "debug",
      );
    }

    // Load and assemble prompt templates at construction time
    const userPrompt = this.assemblePrompt(
      config.userPromptFile,
      config.userPromptText,
      configDirectory,
      "user prompt",
    );

    if (!userPrompt) {
      throw new Error(`[Sentinel:${config.id}] User prompt is required but none provided`);
    }
    this.userPromptTemplate = userPrompt;

    this.systemPromptTemplate = this.assemblePrompt(
      config.systemPromptFile,
      config.systemPromptText,
      configDirectory,
      "system prompt",
    );

    // Create history manager if conversational mode is enabled
    if (config.conversational) {
      // Validate that conversational sentinels have system prompt
      if (!this.systemPromptTemplate) {
        throw new SentinelFatalError(
          config.id,
          "Conversational sentinel missing required system prompt",
          "configuration",
          true,
        );
      }

      this.historyManager = new HistoryManager(
        config.id,
        this.codonId,
        config.conversational.trimmingStrategy,
        sentinelDir, // May be undefined - that's OK, runs in memory-only mode
        this.logger,
      );

      this.logger?.log(
        `[Sentinel:${config.id}] Initialized conversational mode with ${config.conversational.trimmingStrategy.type} trimming`,
        "info",
      );
    }

    // Initialize output files (ALWAYS - auto-generate if not provided)
    this.outputPaths = this.initializeOutputFiles(outputPaths, executionPath);

    this.logger?.log(
      `[Sentinel:${config.id}] Initialized with ${config.execution.strategy} strategy`,
      "debug",
    );
  }

  /**
   * Handle an incoming event and check if it triggers this sentinel.
   *
   * Processing flow (WITH QUEUEING):
   * 1. Check if event matches trigger criteria
   * 2. If matched, queue trigger according to strategy:
   *    - immediate: Queue immediately
   *    - debounce: Accumulate, queue when timer fires
   *    - count: Accumulate, queue at threshold
   *    - timeWindow: Accumulate, queue on schedule
   * 3. Process queue if not already processing
   *
   * @param event - Server event to process
   */
  public async handleEvent(event: ServerEvent): Promise<void> {
    const triggerResult = this.triggerEngine.processEvent(event);

    if (triggerResult.matched) {
      this.logger?.log(
        `[Sentinel:${this.config.id}] ✓ Trigger MATCHED for ${event.type} - Strategy: ${this.config.execution.strategy}, Events: ${triggerResult.events.length}`,
        "debug",
      );

      const eventsToProcess = triggerResult.events;

      switch (this.config.execution.strategy) {
        case "immediate":
          // Await immediate to propagate fatal errors
          await this.enqueueImmediateTrigger(eventsToProcess);
          break;
        case "debounce":
          this.handleDebounceStrategy(eventsToProcess, this.config.execution.milliseconds);
          break;
        case "count":
          this.handleCountStrategy(eventsToProcess, this.config.execution.threshold);
          break;
        case "timeWindow":
          this.handleTimeWindowStrategy(eventsToProcess, this.config.execution.milliseconds);
          break;
      }
    }
  }

  /**
   * Queue a trigger for immediate execution.
   * For immediate strategy, we await the processing to allow fatal errors to propagate.
   */
  private async enqueueImmediateTrigger(events: ServerEvent[]): Promise<void> {
    const trigger: QueuedTrigger = {
      id: generateId(),
      events,
      strategy: "immediate",
      queuedAt: new Date(),
    };

    this.logger?.log(
      `[Sentinel:${this.config.id}] Queueing immediate trigger with ${events.length} events`,
      "debug",
    );

    this.enqueueAndProcess(trigger);

    // For immediate strategy, await the processing to propagate fatal errors to manager
    await this.queueProcessingPromise;
  }

  /**
   * Enqueue a trigger and start processing if not already running.
   */
  private enqueueAndProcess(trigger: QueuedTrigger): void {
    // Check total queued events across all triggers
    const totalQueuedEvents = this.triggerQueue.reduce((sum, t) => sum + t.events.length, 0);

    if (totalQueuedEvents > this.MAX_BUFFER_SIZE) {
      this.logger?.log(
        `[Sentinel:${this.config.id}] Total queued events (${totalQueuedEvents}) exceeds limit, dropping oldest trigger`,
        "info",
      );
      this.triggerQueue.shift();
    }

    if (this.triggerQueue.length >= this.MAX_QUEUE_SIZE) {
      this.logger?.log(
        `[Sentinel:${this.config.id}] Queue full (${this.MAX_QUEUE_SIZE} triggers), dropping oldest trigger`,
        "info",
      );
      this.triggerQueue.shift();
    }

    this.triggerQueue.push(trigger);

    this.logger?.log(
      `[Sentinel:${this.config.id}] Trigger ${trigger.id} queued (strategy: ${trigger.strategy}, queue size: ${this.triggerQueue.length})`,
      "debug",
    );

    // Check backpressure
    this.checkBackpressure();

    // Start processing if not already running
    if (!this.isProcessingQueue) {
      this.queueProcessingPromise = this.processQueue();
    }
  }

  /**
   * Process triggers from the queue serially.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      return; // Already processing
    }

    this.isProcessingQueue = true;

    while (this.triggerQueue.length > 0) {
      // Safe to use shift() here because we check length > 0 in while condition
      const trigger = this.triggerQueue.shift();
      if (!trigger) break; // Extra safety check to satisfy linter

      this.logger?.log(
        `[Sentinel:${this.config.id}] Processing trigger ${trigger.id} (${trigger.events.length} events, queued at ${trigger.queuedAt.toISOString()})`,
        "debug",
      );

      try {
        await this.executeTrigger(trigger);
      } catch (error) {
        if (error instanceof SentinelFatalError) {
          // Fatal error - propagate to manager for unloading decision
          this.logger?.log(
            `[Sentinel:${this.config.id}] Fatal error in trigger ${trigger.id}: ${error}`,
            "error",
          );
          this.isProcessingQueue = false;
          throw error; // Let manager handle unloading
        }

        // Regular error handling
        this.logger?.log(
          `[Sentinel:${this.config.id}] Error in trigger ${trigger.id}: ${error}`,
          "error",
        );

        // For immediate strategy with non-conversational, propagate errors for failure tracking
        if (trigger.strategy === "immediate" && !this.config.conversational) {
          this.isProcessingQueue = false;
          throw error; // Let manager track consecutive failures
        }

        // For other strategies/conversational, continue processing next trigger
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Execute a single trigger with its events.
   * Uses trigger.queuedAt for template timestamp to ensure semantic correctness.
   */
  private async executeTrigger(trigger: QueuedTrigger): Promise<void> {
    // Use the callback for test instrumentation
    this.onExecute?.(this.config.id, trigger.events);

    // Increment trigger counter for sequencing
    this.triggerNumber++;

    // Emit sentinel.triggered event if configured (default OFF per spec)
    const shouldEmitTriggered = this.config.reportToWebsocket?.triggers === true;
    if (shouldEmitTriggered && this.sendEventToServer) {
      this.sendEventToServer({
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "sentinel.triggered",
        data: {
          sentinelId: this.config.id,
          codonId: this.codonId,
          triggerNumber: this.triggerNumber,
          strategy: this.config.execution.strategy,
          eventCount: trigger.events.length,
          queueSize: this.triggerQueue.length,
        },
      });
    }

    // CRITICAL: Use trigger.queuedAt for templating timestamp
    // This ensures consistent time even if execution is delayed by queue
    const templateContext: TemplateContext = {
      events: trigger.events,
      codon: {
        id: this.codonId,
        name: this.config.name,
        description: this.config.description,
        startTime: this.runStartTime,
      },
      world: {
        // IMPORTANT: This must be trigger.queuedAt, NOT new Date()
        // Templates should see when the trigger HAPPENED, not when it's EXECUTING
        currentTime: trigger.queuedAt,
      },
    };

    // Render user prompt template with focused error handling
    let userMessage: string;
    try {
      userMessage = await TemplateRenderer.render(this.userPromptTemplate, templateContext);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Template syntax error")) {
        throw new SentinelFatalError(
          this.config.id,
          `Template syntax permanently broken: ${error.message}`,
          "template",
          true,
        );
      }
      if (error instanceof Error && error.message.includes("Template rendering failed")) {
        this.logger?.log(
          `[Sentinel:${this.config.id}] Template rendering failed: ${error.message}`,
          "error",
        );
        return; // Terminate execution cycle
      }
      throw error;
    }

    // Render system prompt template if available, with same error handling
    let renderedSystemPrompt: string | undefined;
    if (this.systemPromptTemplate) {
      try {
        renderedSystemPrompt = await TemplateRenderer.render(
          this.systemPromptTemplate,
          templateContext,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("Template syntax error")) {
          throw new SentinelFatalError(
            this.config.id,
            `System prompt template syntax permanently broken: ${error.message}`,
            "template",
            true,
          );
        }
        if (error instanceof Error && error.message.includes("Template rendering failed")) {
          this.logger?.log(
            `[Sentinel:${this.config.id}] System template rendering failed: ${error.message}`,
            "error",
          );
          return; // Terminate execution cycle
        }
        throw error;
      }
    }

    // Branch: structured output or text generation
    if (this.structuredOutputContext && this.llmObjectCall) {
      await this.executeStructuredOutput(
        userMessage,
        renderedSystemPrompt,
        this.structuredOutputContext,
      );
    } else {
      await this.executeTextGeneration(userMessage, renderedSystemPrompt);
    }
  }

  /**
   * Execute text generation (original behavior).
   */
  private async executeTextGeneration(
    userMessage: string,
    renderedSystemPrompt: string | undefined,
  ): Promise<void> {
    if (this.config.conversational && this.historyManager) {
      // Conversational flow
      if (!renderedSystemPrompt) {
        throw new Error(
          `[Sentinel:${this.config.id}] Conversational sentinels require a system prompt`,
        );
      }
      const messages = await this.historyManager.getMessagesToSend(renderedSystemPrompt);
      messages.push({ role: "user", content: userMessage });

      const options: HankweaveGenerateTextOptions = {
        messages,
        temperature: this.llmParams.temperature,
        maxOutputTokens: this.llmParams.maxOutputTokens,
        maxRetries: this.llmParams.maxRetries,
      };

      try {
        const response = await this.llmCall(this.config.id, options);

        // Track successful call
        this.trackSuccessfulLLMCall();

        // Calculate and track cost
        let callCost = 0;
        if (this.modelCost && response.usage) {
          const cost =
            (response.usage.inputTokens / 1_000_000) * this.modelCost.input +
            (response.usage.outputTokens / 1_000_000) * this.modelCost.output;
          this.totalCost += cost;
          callCost = cost;
          this.logger?.log(
            `[Sentinel:${this.config.id}] LLM call cost: $${cost.toFixed(6)} (total: $${this.totalCost.toFixed(6)})`,
            "info",
          );
        }

        // Write to output files
        this.writeOutputFiles(response.text);

        // Emit sentinel.output event if configured
        // Default: outputs enabled, respecting config override
        const shouldEmitOutput = this.config.reportToWebsocket?.outputs !== false;
        if (shouldEmitOutput && this.sendEventToServer) {
          this.sendEventToServer({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "sentinel.output",
            data: {
              sentinelId: this.config.id,
              codonId: this.codonId,
              triggerNumber: this.triggerNumber,
              outputType: "text",
              content: response.text,
              cost: callCost,
              tokens: {
                input: response.usage?.inputTokens || 0,
                output: response.usage?.outputTokens || 0,
              },
              eventCount: 1, // Will be updated when we have access to trigger.events
            },
          });
        }

        const userTokens = response.usage?.inputTokens;
        const assistantTokens = response.usage?.outputTokens;

        await this.historyManager.addMessagePair(
          userMessage,
          response.text,
          userTokens,
          assistantTokens,
        );
      } catch (error) {
        // Track failed call
        this.trackFailedLLMCall();

        this.logger?.log(`[Sentinel:${this.config.id}] LLM call failed: ${error}`, "error");

        // Emit sentinel.error event if configured (default ON)
        const shouldEmitErrors = this.config.reportToWebsocket?.errors !== false;
        if (shouldEmitErrors && this.sendEventToServer) {
          this.sendEventToServer({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "sentinel.error",
            data: {
              sentinelId: this.config.id,
              codonId: this.codonId,
              errorType: "llm-call-failed",
              message: error instanceof Error ? error.message : String(error),
              retriable: true,
              consecutiveFailureCount: this.failedLLMCallsCount,
            },
          });
        }

        if (this.config.conversational?.continueOnError === true) {
          this.logger?.log(
            `[Sentinel:${this.config.id}] Ignoring error as per configuration and continuing conversation`,
            "info",
          );
        } else {
          throw error;
        }
      }
    } else {
      // Non-conversational flow
      const options: HankweaveGenerateTextOptions = {
        messages: [{ role: "user", content: userMessage }],
        system: renderedSystemPrompt,
        temperature: this.llmParams.temperature,
        maxOutputTokens: this.llmParams.maxOutputTokens,
        maxRetries: this.llmParams.maxRetries,
      };

      try {
        const response = await this.llmCall(this.config.id, options);

        // Track successful call
        this.trackSuccessfulLLMCall();

        let callCost = 0;
        if (this.modelCost && response.usage) {
          const cost =
            (response.usage.inputTokens / 1_000_000) * this.modelCost.input +
            (response.usage.outputTokens / 1_000_000) * this.modelCost.output;
          this.totalCost += cost;
          callCost = cost;
          this.logger?.log(
            `[Sentinel:${this.config.id}] LLM call cost: $${cost.toFixed(6)} (total: $${this.totalCost.toFixed(6)})`,
            "info",
          );
        }

        // Write to output files
        this.writeOutputFiles(response.text);

        // Emit sentinel.output event if configured
        const shouldEmitOutput = this.config.reportToWebsocket?.outputs !== false;
        if (shouldEmitOutput && this.sendEventToServer) {
          this.sendEventToServer({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "sentinel.output",
            data: {
              sentinelId: this.config.id,
              codonId: this.codonId,
              triggerNumber: this.triggerNumber,
              outputType: "text",
              content: response.text,
              cost: callCost,
              tokens: {
                input: response.usage?.inputTokens || 0,
                output: response.usage?.outputTokens || 0,
              },
              eventCount: 1,
            },
          });
        }
      } catch (error) {
        // Track failed call
        this.trackFailedLLMCall();

        this.logger?.log(`[Sentinel:${this.config.id}] LLM call failed: ${error}`, "error");

        // Emit sentinel.error event if configured (default ON)
        const shouldEmitErrors = this.config.reportToWebsocket?.errors !== false;
        if (shouldEmitErrors && this.sendEventToServer) {
          this.sendEventToServer({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "sentinel.error",
            data: {
              sentinelId: this.config.id,
              codonId: this.codonId,
              errorType: "llm-call-failed",
              message: error instanceof Error ? error.message : String(error),
              retriable: true,
              consecutiveFailureCount: this.failedLLMCallsCount,
            },
          });
        }

        throw error;
      }
    }
  }

  /**
   * Execute structured output generation.
   */
  private async executeStructuredOutput(
    userMessage: string,
    renderedSystemPrompt: string | undefined,
    context: StructuredOutputContext,
  ): Promise<void> {
    if (!this.llmObjectCall) {
      throw new SentinelFatalError(
        this.config.id,
        "llmObjectCall required for structured output but not provided",
        "configuration",
        true,
      );
    }

    if (this.config.conversational && this.historyManager) {
      // Conversational flow
      if (!renderedSystemPrompt) {
        throw new Error(
          `[Sentinel:${this.config.id}] Conversational sentinels require a system prompt`,
        );
      }
      const messages = await this.historyManager.getMessagesToSend(renderedSystemPrompt);
      messages.push({ role: "user", content: userMessage });

      // Build options based on output mode
      const baseOptions = {
        messages,
        output: context.output,
        schemaName: context.schemaName,
        schemaDescription: context.schemaDescription,
        temperature: this.llmParams.temperature,
        maxOutputTokens: this.llmParams.maxOutputTokens,
        maxRetries: this.llmParams.maxRetries,
      };

      // Add schema OR enum values depending on mode
      const options: HankweaveGenerateObjectOptions =
        context.output === "enum"
          ? { ...baseOptions, enum: context.enumValues }
          : { ...baseOptions, schema: context.zodSchema };

      try {
        const response = await this.llmObjectCall(this.config.id, options);

        // Track successful call
        this.trackSuccessfulLLMCall();

        // Track cost
        let callCost = 0;
        if (this.modelCost && response.usage) {
          const cost =
            (response.usage.inputTokens / 1_000_000) * this.modelCost.input +
            (response.usage.outputTokens / 1_000_000) * this.modelCost.output;
          this.totalCost += cost;
          callCost = cost;
          this.logger?.log(
            `[Sentinel:${this.config.id}] LLM call cost: $${cost.toFixed(6)} (total: $${this.totalCost.toFixed(6)})`,
            "info",
          );
        }

        const userTokens = response.usage?.inputTokens;
        const assistantTokens = response.usage?.outputTokens;

        // Log generated object for debugging and testing
        this.logger?.log(
          `[Sentinel:${this.config.id}] Generated object: ${JSON.stringify(response.object)}`,
          "debug",
        );

        // Write to output files
        this.writeOutputFiles(response.object as object);

        // Emit sentinel.output event if configured
        const shouldEmitOutput = this.config.reportToWebsocket?.outputs !== false;
        if (shouldEmitOutput && this.sendEventToServer) {
          this.sendEventToServer({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "sentinel.output",
            data: {
              sentinelId: this.config.id,
              codonId: this.codonId,
              triggerNumber: this.triggerNumber,
              outputType: "structured",
              content: response.object as Record<string, unknown>,
              cost: callCost,
              tokens: {
                input: response.usage?.inputTokens || 0,
                output: response.usage?.outputTokens || 0,
              },
              eventCount: 1,
            },
          });
        }

        // Store object (addMessagePair handles stringification)
        await this.historyManager.addMessagePair(
          userMessage,
          response.object as string | object,
          userTokens,
          assistantTokens,
        );
      } catch (error) {
        // Track failed call
        this.trackFailedLLMCall();

        this.logger?.log(`[Sentinel:${this.config.id}] LLM call failed: ${error}`, "error");

        // Emit sentinel.error event if configured (default ON)
        const shouldEmitErrors = this.config.reportToWebsocket?.errors !== false;
        if (shouldEmitErrors && this.sendEventToServer) {
          this.sendEventToServer({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "sentinel.error",
            data: {
              sentinelId: this.config.id,
              codonId: this.codonId,
              errorType: "llm-call-failed",
              message: error instanceof Error ? error.message : String(error),
              retriable: true,
              consecutiveFailureCount: this.failedLLMCallsCount,
            },
          });
        }

        if (this.config.conversational?.continueOnError === true) {
          this.logger?.log(
            `[Sentinel:${this.config.id}] Ignoring error as per configuration and continuing conversation`,
            "info",
          );
        } else {
          throw error;
        }
      }
    } else {
      // Non-conversational flow
      const baseOptions = {
        messages: [{ role: "user" as const, content: userMessage }],
        system: renderedSystemPrompt,
        output: context.output,
        schemaName: context.schemaName,
        schemaDescription: context.schemaDescription,
        temperature: this.llmParams.temperature,
        maxOutputTokens: this.llmParams.maxOutputTokens,
        maxRetries: this.llmParams.maxRetries,
      };

      const options: HankweaveGenerateObjectOptions =
        context.output === "enum"
          ? ({
              ...baseOptions,
              enum: context.enumValues,
            } as HankweaveGenerateObjectOptions)
          : ({
              ...baseOptions,
              schema: context.zodSchema,
            } as HankweaveGenerateObjectOptions);

      try {
        const response = await this.llmObjectCall(this.config.id, options);

        // Track successful call
        this.trackSuccessfulLLMCall();

        let callCost = 0;
        if (this.modelCost && response.usage) {
          const cost =
            (response.usage.inputTokens / 1_000_000) * this.modelCost.input +
            (response.usage.outputTokens / 1_000_000) * this.modelCost.output;
          this.totalCost += cost;
          callCost = cost;
          this.logger?.log(
            `[Sentinel:${this.config.id}] LLM call cost: $${cost.toFixed(6)} (total: $${this.totalCost.toFixed(6)})`,
            "info",
          );
        }

        // Log generated object but don't store
        this.logger?.log(
          `[Sentinel:${this.config.id}] Generated object: ${JSON.stringify(response.object)}`,
          "debug",
        );

        // Write to output files
        this.writeOutputFiles(response.object as object);

        // Emit sentinel.output event if configured
        const shouldEmitOutput = this.config.reportToWebsocket?.outputs !== false;
        if (shouldEmitOutput && this.sendEventToServer) {
          this.sendEventToServer({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "sentinel.output",
            data: {
              sentinelId: this.config.id,
              codonId: this.codonId,
              triggerNumber: this.triggerNumber,
              outputType: "structured",
              content: response.object as Record<string, unknown>,
              cost: callCost,
              tokens: {
                input: response.usage?.inputTokens || 0,
                output: response.usage?.outputTokens || 0,
              },
              eventCount: 1,
            },
          });
        }
      } catch (error) {
        // Track failed call
        this.trackFailedLLMCall();

        this.logger?.log(`[Sentinel:${this.config.id}] LLM call failed: ${error}`, "error");

        // Emit sentinel.error event if configured (default ON)
        const shouldEmitErrors = this.config.reportToWebsocket?.errors !== false;
        if (shouldEmitErrors && this.sendEventToServer) {
          this.sendEventToServer({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "sentinel.error",
            data: {
              sentinelId: this.config.id,
              codonId: this.codonId,
              errorType: "llm-call-failed",
              message: error instanceof Error ? error.message : String(error),
              retriable: true,
              consecutiveFailureCount: this.failedLLMCallsCount,
            },
          });
        }

        throw error;
      }
    }
  }

  /**
   * Check backpressure and log warnings if queue is getting full.
   */
  private checkBackpressure(): void {
    const queueSize = this.triggerQueue.length;
    const threshold = this.MAX_QUEUE_SIZE * 0.7; // 70% full

    if (queueSize > threshold) {
      this.logger?.log(
        `[Sentinel:${this.config.id}] Queue backpressure: ${queueSize}/${this.MAX_QUEUE_SIZE} triggers queued`,
        "info",
      );
    }
  }

  /**
   * Handle debounce strategy - accumulate events and queue when timer fires.
   */
  private handleDebounceStrategy(events: ServerEvent[], milliseconds: number): void {
    // Accumulate events
    if (this.pendingDebounce) {
      this.pendingDebounce.events.push(...events);
      clearTimeout(this.pendingDebounce.timer);
      this.logger?.log(
        `[Sentinel:${this.config.id}] Debounce: Added ${events.length} events, total: ${this.pendingDebounce.events.length}, resetting timer`,
        "debug",
      );
    } else {
      this.pendingDebounce = {
        events: [...events],
        timer: undefined as unknown as Timer, // Will be set below
      };
      this.logger?.log(
        `[Sentinel:${this.config.id}] Debounce: Starting with ${events.length} events, timer: ${milliseconds}ms`,
        "debug",
      );
    }

    // Set/reset timer
    this.pendingDebounce.timer = setTimeout(() => {
      if (!this.pendingDebounce) return; // Safety check

      const accumulatedEvents = this.pendingDebounce.events;
      this.pendingDebounce = undefined;

      this.logger?.log(
        `[Sentinel:${this.config.id}] Debounce timer fired, queueing trigger with ${accumulatedEvents.length} events`,
        "info",
      );

      // Queue the trigger
      const trigger: QueuedTrigger = {
        id: generateId(),
        events: accumulatedEvents,
        strategy: "debounce",
        queuedAt: new Date(),
      };

      this.enqueueAndProcess(trigger);
    }, milliseconds);
  }

  /**
   * Handle count strategy - accumulate events and queue when threshold reached.
   */
  private handleCountStrategy(events: ServerEvent[], threshold: number): void {
    this.pendingEvents.push(...events);

    this.logger?.log(
      `[Sentinel:${this.config.id}] Count: Added ${events.length} events, total: ${this.pendingEvents.length}/${threshold}`,
      "debug",
    );

    // Queue triggers for each complete batch
    while (this.pendingEvents.length >= threshold) {
      const batchEvents = this.pendingEvents.splice(0, threshold);

      this.logger?.log(
        `[Sentinel:${this.config.id}] Count threshold reached, queueing trigger with ${batchEvents.length} events`,
        "info",
      );

      const trigger: QueuedTrigger = {
        id: generateId(),
        events: batchEvents,
        strategy: "count",
        queuedAt: new Date(),
      };

      this.enqueueAndProcess(trigger);
    }
  }

  /**
   * Handle time window strategy - accumulate events and queue on schedule.
   */
  private handleTimeWindowStrategy(events: ServerEvent[], milliseconds: number): void {
    this.pendingEvents.push(...events);

    this.logger?.log(
      `[Sentinel:${this.config.id}] TimeWindow: Added ${events.length} events, total: ${this.pendingEvents.length}`,
      "debug",
    );

    if (!this.timeWindowTimer) {
      this.logger?.log(
        `[Sentinel:${this.config.id}] Starting time window loop: ${milliseconds}ms`,
        "info",
      );
      this.startTimeWindowLoop(milliseconds);
    }
  }

  /**
   * Start a periodic time window loop that queues triggers at regular intervals.
   *
   * Uses absolute timestamps to prevent drift accumulation from variable LLM
   * call times. The timer fires on a fixed schedule regardless of event arrival.
   */
  private startTimeWindowLoop(milliseconds: number): void {
    if (this.timeWindowTimer) {
      clearTimeout(this.timeWindowTimer);
    }

    // Calculate next window time based on last window, or start now if first time
    const now = Date.now();
    const nextWindowTime = this.lastWindowTime
      ? this.lastWindowTime + milliseconds
      : now + milliseconds;

    // Calculate delay, handling case where we're behind schedule
    const delay = Math.max(0, nextWindowTime - now);

    // If we're significantly behind (> 100ms), log a warning
    if (delay === 0 && this.lastWindowTime) {
      this.logger?.log(
        `[Sentinel:${this.config.id}] Time window behind schedule by ${now - nextWindowTime}ms, firing immediately`,
        "debug",
      );
    }

    this.timeWindowTimer = setTimeout(() => {
      // Record when this window actually fired for next calculation
      this.lastWindowTime = Date.now();

      const eventCount = this.pendingEvents.length;
      if (eventCount > 0) {
        const windowEvents = [...this.pendingEvents];
        this.pendingEvents = [];

        this.logger?.log(
          `[Sentinel:${this.config.id}] Time window closing, queueing trigger with ${eventCount} events`,
          "info",
        );

        const trigger: QueuedTrigger = {
          id: generateId(),
          events: windowEvents,
          strategy: "timeWindow",
          queuedAt: new Date(),
        };

        this.enqueueAndProcess(trigger);
      }

      // Schedule the next window
      this.startTimeWindowLoop(milliseconds);
    }, delay);
  }

  /**
   * Complete all pending work before shutdown/codon-end.
   *
   * This method:
   * 1. Stops timers (no new triggers created)
   * 2. Converts any buffered events into final triggers
   * 3. Waits for all queued triggers to execute
   *
   * Called by SentinelManager during graceful shutdown.
   * After this completes, calling destroy() should have no pending work.
   */
  public async completeAllWork(): Promise<void> {
    this.logger?.log(
      `[Sentinel:${this.config.id}] Completing all work: ${this.triggerQueue.length} triggers queued`,
      "info",
    );

    // 1. Stop time-based trigger creation
    if (this.timeWindowTimer) {
      clearTimeout(this.timeWindowTimer);
      this.timeWindowTimer = undefined;
    }

    // 2. Convert pending debounce into final trigger
    if (this.pendingDebounce) {
      clearTimeout(this.pendingDebounce.timer);

      this.logger?.log(
        `[Sentinel:${this.config.id}] Finalizing pending debounce with ${this.pendingDebounce.events.length} events`,
        "debug",
      );

      const trigger: QueuedTrigger = {
        id: generateId(),
        events: this.pendingDebounce.events,
        strategy: "debounce",
        queuedAt: new Date(),
      };
      this.enqueueAndProcess(trigger);
      this.pendingDebounce = undefined;
    }

    // 3. Convert remaining count buffer into final trigger
    if (this.pendingEvents.length > 0) {
      this.logger?.log(
        `[Sentinel:${this.config.id}] Finalizing pending count buffer with ${this.pendingEvents.length} events`,
        "debug",
      );

      const trigger: QueuedTrigger = {
        id: generateId(),
        events: [...this.pendingEvents],
        strategy: "count",
        queuedAt: new Date(),
      };
      this.enqueueAndProcess(trigger);
      this.pendingEvents = [];
    }

    // 4. Wait for queue to drain completely
    while (this.isProcessingQueue || this.triggerQueue.length > 0) {
      await this.queueProcessingPromise;
      // Check again in case triggers were queued during processing
      if (this.triggerQueue.length > 0 && !this.isProcessingQueue) {
        this.queueProcessingPromise = this.processQueue();
      }
    }

    this.logger?.log(`[Sentinel:${this.config.id}] All work completed`, "info");
  }

  /**
   * Helper to clear all active timers.
   */
  private destroyTimers(): void {
    if (this.pendingDebounce) {
      clearTimeout(this.pendingDebounce.timer);
      this.pendingDebounce = undefined;
    }
    if (this.timeWindowTimer) {
      clearTimeout(this.timeWindowTimer);
      this.timeWindowTimer = undefined;
    }
  }

  /**
   * Load and validate Zod schema from configuration.
   * Returns StructuredOutputContext for use in object generation.
   */
  private loadStructuredOutputSchema(configDirectory?: string): StructuredOutputContext {
    // Safe to assert: constructor only calls this when structuredOutput exists
    const cfg =
      this.config.structuredOutput ??
      (() => {
        throw new Error("structuredOutput should be defined");
      })();

    // Enum mode - no schema needed
    if (cfg.output === "enum") {
      if (!cfg.enumValues || cfg.enumValues.length === 0) {
        throw new SentinelFatalError(
          this.config.id,
          "Enum output requires enumValues",
          "configuration",
          true,
        );
      }
      return {
        zodSchema: undefined, // Enum doesn't use schema
        output: "enum",
        enumValues: cfg.enumValues,
      };
    }

    // Object/Array mode - load schema (refinement ensures exactly one exists)
    let schemaCode: string;
    if (cfg.schemaFile) {
      const resolvedPath =
        configDirectory && !path.isAbsolute(cfg.schemaFile)
          ? path.resolve(configDirectory, cfg.schemaFile)
          : cfg.schemaFile;

      try {
        schemaCode = fs.readFileSync(resolvedPath, "utf-8");
      } catch (error) {
        throw new SentinelFatalError(
          this.config.id,
          `Failed to load schema file "${cfg.schemaFile}": ${error instanceof Error ? error.message : String(error)}`,
          "configuration",
          true,
        );
      }
    } else if (cfg.schemaStr) {
      schemaCode = cfg.schemaStr;
    } else {
      throw new SentinelFatalError(
        this.config.id,
        "Object/array mode requires schemaStr or schemaFile",
        "configuration",
        true,
      );
    }

    // Evaluate schema code to get Zod schema
    let zodSchema: z.ZodType<unknown>;
    try {
      const schemaFn = new Function("z", `return ${schemaCode}`);
      zodSchema = schemaFn(z) as z.ZodType<unknown>;
    } catch (error) {
      throw new SentinelFatalError(
        this.config.id,
        `Invalid Zod schema code: ${error instanceof Error ? error.message : String(error)}`,
        "configuration",
        true,
      );
    }

    // Validate it's actually a Zod schema
    if (!zodSchema || typeof zodSchema.parse !== "function") {
      throw new SentinelFatalError(
        this.config.id,
        "Schema must be a valid Zod schema with parse method",
        "configuration",
        true,
      );
    }

    return {
      zodSchema,
      output: cfg.output,
      schemaName: cfg.schemaName,
      schemaDescription: cfg.schemaDescription,
    };
  }

  /**
   * Assembles a prompt from files and/or text
   */
  private assemblePrompt(
    files: string | string[] | undefined,
    text: string | undefined,
    configDirectory: string | undefined,
    promptType: string,
  ): string | undefined {
    const parts: string[] = [];

    // Load files first
    if (files) {
      const fileArray = Array.isArray(files) ? files : [files];
      for (const file of fileArray) {
        try {
          // Resolve relative paths relative to config directory
          const resolvedPath =
            configDirectory && !path.isAbsolute(file) ? path.resolve(configDirectory, file) : file;

          const content = fs.readFileSync(resolvedPath, "utf-8");
          parts.push(content);
        } catch (error) {
          throw new Error(
            `[Sentinel:${this.config.id}] Failed to load ${promptType} file "${file}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    // Add text if provided
    if (text) {
      parts.push(text);
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  /**
   * Get the sentinel's ID.
   */
  public getId(): string {
    return this.config.id;
  }

  /**
   * Get the total cost accumulated by this sentinel.
   */
  public getTotalCost(): number {
    return this.totalCost;
  }

  /**
   * Get the history manager for this sentinel.
   *
   * Only available for conversational sentinels. Used for testing
   * to verify conversation state management.
   *
   * @returns HistoryManager instance if conversational, undefined otherwise
   */
  public getHistoryManager(): HistoryManager | undefined {
    return this.historyManager;
  }

  /**
   * Get sentinel state for persistence.
   * Returns current state snapshot for storing in codon state.
   */
  public getSentinelState(): import("../types/state-types.js").SentinelState {
    return {
      id: this.config.id,
      model: this.config.model,
      loadedAt: this.runStartTime.toISOString(),
      llmCallCount: this.llmCallCount,
      failedLLMCalls: this.failedLLMCallsCount,
      lastLlmCallAt: this.lastLlmCallAt?.toISOString(),
      totalTriggers: this.triggerNumber,
      totalCost: this.totalCost,
      status: "active",
    };
  }

  /**
   * Track successful LLM call.
   */
  private trackSuccessfulLLMCall(): void {
    this.llmCallCount++;
    this.lastLlmCallAt = new Date();
  }

  /**
   * Track failed LLM call.
   */
  private trackFailedLLMCall(): void {
    this.failedLLMCallsCount++;
    this.lastLlmCallAt = new Date();
  }

  // -------------
  // Output File Management
  // -------------

  /**
   * Initialize output file paths and create necessary directories.
   * Auto-generates logFile if not provided.
   *
   * @param outputPaths - Optional paths from codon config
   * @param executionPath - Execution directory for path resolution
   * @returns Resolved absolute paths and processed joinString
   * @throws SentinelFatalError if validation or creation fails
   */
  private initializeOutputFiles(
    outputPaths: SentinelOutputPaths | undefined,
    executionPath?: string,
  ): {
    continuousLog: string;
    currentValue: string | undefined;
    joinString: string;
  } {
    if (!executionPath) {
      // No execution path - generate a no-op placeholder that won't write
      // This allows tests to run without providing execution paths
      this.logger?.log(
        `[Sentinel:${this.config.id}] No execution path provided - output files disabled`,
        "debug",
      );

      const rawJoinString = this.config.joinString || "\n---\n";
      const processedJoinString = this.processEscapeSequences(rawJoinString);

      return {
        continuousLog: "", // Empty path signals no-op
        currentValue: undefined,
        joinString: processedJoinString,
      };
    }

    // Determine logFile path (auto-generate if needed)
    let logFilePath: string;

    if (!outputPaths?.logFile) {
      // Auto-generate
      logFilePath = this.generateLogFilePath(executionPath);
      this.logger?.log(
        `[Sentinel:${this.config.id}] Auto-generated logFile: ${path.relative(executionPath, logFilePath)}`,
        "info",
      );
    } else {
      // User-provided - apply path convention
      logFilePath = this.resolveOutputPath(outputPaths.logFile, executionPath);
    }

    // Resolve lastValueFile if provided
    const lastValuePath = outputPaths?.lastValueFile
      ? this.resolveOutputPath(outputPaths.lastValueFile, executionPath)
      : undefined;

    // Validate paths stay within execution directory
    this.validatePathSafety(logFilePath, executionPath);
    if (lastValuePath) {
      this.validatePathSafety(lastValuePath, executionPath);
    }

    // Validate extensions for structured output
    if (this.config.structuredOutput) {
      if (!logFilePath.endsWith(".ndjson") && !logFilePath.endsWith(".jsonl")) {
        throw new SentinelFatalError(
          this.config.id,
          `Structured output logFile must use .ndjson or .jsonl extension: ${logFilePath}`,
          "configuration",
          true,
        );
      }
      if (lastValuePath && !lastValuePath.endsWith(".json")) {
        throw new SentinelFatalError(
          this.config.id,
          `Structured output lastValueFile must use .json extension: ${lastValuePath}`,
          "configuration",
          true,
        );
      }
    }

    // Create directories and files
    const paths = [logFilePath, lastValuePath].filter(Boolean) as string[];
    for (const filePath of paths) {
      // Create parent directory
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } catch (error) {
        throw new SentinelFatalError(
          this.config.id,
          `Failed to create directory for ${filePath}: ${error}`,
          "configuration",
          true,
        );
      }

      // Create empty file if doesn't exist (idempotent for resumption)
      try {
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, "");
        }
      } catch (error) {
        throw new SentinelFatalError(
          this.config.id,
          `Failed to create file ${filePath}: ${error}`,
          "configuration",
          true,
        );
      }

      // Verify write permissions
      try {
        fs.accessSync(filePath, fs.constants.W_OK);
      } catch (_error) {
        throw new SentinelFatalError(
          this.config.id,
          `Output file not writable: ${filePath}`,
          "configuration",
          true,
        );
      }
    }

    this.logger?.log(
      `[Sentinel:${this.config.id}] Output files initialized:` +
        `\n  Log: ${path.relative(executionPath, logFilePath)}` +
        (lastValuePath ? `\n  LastValue: ${path.relative(executionPath, lastValuePath)}` : ""),
      "info",
    );

    // Process escape sequences in joinString
    const rawJoinString = this.config.joinString || "\n---\n";
    const processedJoinString = this.processEscapeSequences(rawJoinString);

    return {
      continuousLog: logFilePath,
      currentValue: lastValuePath,
      joinString: processedJoinString,
    };
  }

  /**
   * Generate auto path for logFile.
   * Format: .hankweave/sentinels/outputs/{id}/{id}-{codon}-{timestamp}.{ext}
   */
  private generateLogFilePath(executionPath: string): string {
    const timestamp = Date.now();
    const extension = this.config.structuredOutput ? "ndjson" : "md";
    const filename = `${this.config.id}-${this.codonId}-${timestamp}.${extension}`;

    return path.join(executionPath, ".hankweave", "sentinels", "outputs", this.config.id, filename);
  }

  /**
   * Resolve output path based on format:
   * - Filename only (no '/'): .hankweave/sentinels/outputs/{id}/{filename}
   * - Path with '/' (including './'): relative to agentRootPath (where agents work)
   *
   * This allows users to write sentinel outputs to the agent's working directory
   * using explicit paths like './output.log' or 'subdir/output.log'.
   */
  private resolveOutputPath(userPath: string, executionPath: string): string {
    if (userPath.includes("/")) {
      // Explicit path - use agentRootPath if available, fallback to executionPath
      // This makes paths like './output.log' resolve correctly to agent workspace
      const basePath = this.agentRootPath || executionPath;
      return path.join(basePath, userPath);
    }
    // Filename only - stays in managed sentinel outputs directory
    return path.join(executionPath, ".hankweave", "sentinels", "outputs", this.config.id, userPath);
  }

  /**
   * Validate that resolved path stays within allowed directories.
   * Paths must be within either executionPath or agentRootPath.
   */
  private validatePathSafety(filePath: string, executionPath: string): void {
    const resolved = path.resolve(filePath);
    const execResolved = path.resolve(executionPath);

    // Allow paths within executionPath
    if (resolved.startsWith(execResolved)) {
      return;
    }

    // Also allow paths within agentRootPath if available
    if (this.agentRootPath) {
      const agentResolved = path.resolve(this.agentRootPath);
      if (resolved.startsWith(agentResolved)) {
        return;
      }
    }

    throw new SentinelFatalError(
      this.config.id,
      `Output path escapes allowed directories: ${filePath}`,
      "configuration",
      true,
    );
  }

  /**
   * Process escape sequences in joinString.
   * Supports: \n (newline), \t (tab), \r (carriage return), \\ (backslash)
   */
  private processEscapeSequences(str: string): string {
    return str
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\\\/g, "\\");
  }

  /**
   * Write content to a file atomically (write to temp, then rename).
   * Prevents corruption if process crashes mid-write.
   */
  private writeAtomic(filePath: string, content: string): void {
    const tempPath = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tempPath, content, "utf-8");
      // Use retry logic for Windows file locking issues
      renameWithRetrySync(tempPath, filePath, { logger: this.logger });
    } catch (error) {
      // Clean up temp file if rename failed
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }

  /**
   * Write LLM output to files.
   * Called after successful text or structured generation.
   */
  private writeOutputFiles(output: string | object): void {
    // No-op if no output paths configured (e.g., in tests)
    if (!this.outputPaths.continuousLog) return;

    const isStructured = typeof output === "object";

    try {
      if (isStructured) {
        // Structured output
        const jsonLine = JSON.stringify(output);
        const jsonPretty = JSON.stringify(output, null, 2);

        // Append to logFile (NDJSON - one object per line)
        fs.appendFileSync(this.outputPaths.continuousLog, `${jsonLine}\n`);

        // Replace lastValueFile if configured (pretty JSON)
        if (this.outputPaths.currentValue) {
          this.writeAtomic(this.outputPaths.currentValue, jsonPretty);
        }

        this.logger?.log(`[Sentinel:${this.config.id}] Wrote structured output`, "debug");
      } else {
        // Text output
        const text = output as string;

        // Append to logFile with processed joinString
        fs.appendFileSync(
          this.outputPaths.continuousLog,
          `${this.outputPaths.joinString + text}\n`,
        );

        // Replace lastValueFile if configured (no joinString)
        if (this.outputPaths.currentValue) {
          this.writeAtomic(this.outputPaths.currentValue, text);
        }

        this.logger?.log(
          `[Sentinel:${this.config.id}] Wrote text output (${text.length} chars)`,
          "debug",
        );
      }
    } catch (error) {
      // Don't throw - log error but continue execution
      this.logger?.log(
        `[Sentinel:${this.config.id}] Failed to write output files: ${error}`,
        "error",
      );
    }
  }

  /**
   * Clean up all resources when destroying the sentinel.
   *
   * Cleanup operations:
   * - Stops all active timers (debounce, timeWindow)
   * - DROPS all queued triggers (doesn't execute them)
   * - Clears pending event buffers
   * - Resets trigger engine state
   *
   * This is forceful cleanup - use completeAllWork() first for graceful completion.
   *
   * Called by SentinelManager when unloading a sentinel or during shutdown.
   * Safe to call multiple times (idempotent).
   */
  public destroy(): void {
    // Stop timers
    this.destroyTimers();

    // Clear buffers
    this.pendingEvents = [];

    // Drop the queue and log if anything was dropped
    const droppedCount = this.triggerQueue.length;
    this.triggerQueue = [];

    if (droppedCount > 0) {
      this.logger?.log(
        `[Sentinel:${this.config.id}] Destroyed with ${droppedCount} pending triggers dropped`,
        "info",
      );
    }

    // Reset processing state
    this.isProcessingQueue = false;
    this.queueProcessingPromise = undefined;

    // Reset trigger engine
    this.triggerEngine.reset();

    this.logger?.log(`[Sentinel:${this.config.id}] Destroyed.`, "debug");
  }
}
