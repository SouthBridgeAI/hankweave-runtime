import type { ServerEvent } from "../schemas/event-schemas.js";
import type { ChroniclerConfig } from "../types/chronicler-types.js";
import { Chronicler } from "./chronicler.js";

/**
 * Manages multiple Chronicler instances for a phase.
 * Orchestrates event distribution and lifecycle management.
 */
export class ChroniclerManager {
  private chroniclers: Chronicler[] = [];
  private llmCallFunction?: (id: string, events: ServerEvent[]) => Promise<unknown>;

  /**
   * Load chronicler configurations and create instances.
   */
  public async loadChroniclers(
    configs: ChroniclerConfig[],
    llmCall: (id: string, events: ServerEvent[]) => Promise<unknown>,
  ): Promise<void> {
    this.llmCallFunction = llmCall;
    this.chroniclers = configs.map((config) => new Chronicler(config, llmCall));
  }

  /**
   * Handle an incoming event by distributing it to all chroniclers.
   */
  public async handleEvent(event: ServerEvent): Promise<void> {
    // Process event for each chronicler in parallel
    const promises = this.chroniclers.map((chronicler) => chronicler.handleEvent(event));

    // Wait for all chroniclers to process the event
    // We use allSettled to ensure one chronicler error doesn't affect others
    const results = await Promise.allSettled(promises);

    // Log any errors but don't throw - chroniclers should be non-blocking
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        console.error(
          `Chronicler ${this.chroniclers[index].getId()} failed to process event:`,
          result.reason,
        );
      }
    }
  }

  /**
   * Flush all pending events from all chroniclers.
   * Used when processing is complete or when shutting down.
   */
  public async flush(): Promise<void> {
    const promises = this.chroniclers.map((chronicler) => chronicler.flush());

    // Wait for all chroniclers to flush
    const results = await Promise.allSettled(promises);

    // Log any errors
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        console.error(
          `Chronicler ${this.chroniclers[index].getId()} failed to flush:`,
          result.reason,
        );
      }
    }
  }

  /**
   * Shutdown the manager and all chroniclers.
   * Flushes pending events and cleans up resources.
   */
  public async shutdown(): Promise<void> {
    await this.flush();
    this.chroniclers = [];
    this.llmCallFunction = undefined;
  }

  /**
   * Get the number of active chroniclers.
   */
  public getChroniclerCount(): number {
    return this.chroniclers.length;
  }

  /**
   * Get the IDs of all active chroniclers.
   */
  public getChroniclerIds(): string[] {
    return this.chroniclers.map((c) => c.getId());
  }
}
