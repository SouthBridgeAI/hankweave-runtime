import { Eta } from "eta";
import type { ServerEvent } from "../schemas/event-schemas.js";

/**
 * Maximum number of events that can be passed to a template.
 * This limit prevents performance issues with large event arrays.
 */
export const MAX_EVENTS_FOR_TEMPLATE = 1000;

export interface TemplateContext {
  events: ServerEvent[];
  codon: {
    id: string;
    name: string;
    description?: string;
    startTime: Date;
  };
  world: {
    currentTime: Date;
  };
}

/**
 * Global Eta instance with native caching enabled
 */
const globalEta = new Eta({
  cache: true, // Use Eta's native template caching
  autoEscape: false, // Raw output for sentinel use case
  rmWhitespace: false, // Preserve template whitespace
});

/**
 * Renders a template string with the provided context.
 *
 * IMPORTANT: Templates are executed synchronously and cannot be interrupted.
 * Keep templates lightweight and avoid complex computations or infinite loops.
 *
 * @param templateString The Eta template string to render
 * @param context The context object available as 'it' in templates
 * @returns The rendered string
 * @throws Error if template compilation or rendering fails
 */
export async function renderTemplate(
  templateString: string,
  context: TemplateContext,
): Promise<string> {
  // Limit the number of events to prevent performance issues
  const limitedContext: TemplateContext = {
    ...context,
    events: context.events.slice(0, MAX_EVENTS_FOR_TEMPLATE),
  };

  try {
    // Note: renderString is synchronous despite our async wrapper
    const result = globalEta.renderString(templateString, limitedContext);
    return result;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Template rendering failed: ${error.message}`);
    }
    throw new Error(`Template rendering failed: ${String(error)}`);
  }
}

/**
 * Creates a new global Eta instance - useful for testing to clear cache
 */
export function resetTemplateCache(): void {
  // Replace the global instance to clear all caches
  Object.assign(
    globalEta,
    new Eta({
      cache: true,
      autoEscape: false,
      rmWhitespace: false,
    }),
  );
}

// Export for backward compatibility during transition
export const TemplateRenderer = {
  render: renderTemplate,
  resetCache: resetTemplateCache,
};
