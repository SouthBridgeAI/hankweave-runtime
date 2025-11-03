# Chronicler System Documentation

## Overview

The Chronicler System is a parallel observation feature for the Tadpole Runner that enables extraction of information, evaluation of agent behavior, and generation of human-readable summaries by running lightweight, parallel LLM calls that observe the main agent's activity stream without interfering with it.

## Architecture

### Core Components

1. **Trigger System** - Declarative, event-driven engine for activating chroniclers
2. **Execution Strategies** - Different ways to batch and process events
3. **Condition Evaluator** - Evaluates trigger conditions against event data
4. **Event Schemas** - Zod-first schemas with inferred TypeScript types

### Key Files

- `server/types/chronicler-types.ts` - TypeScript type definitions for chroniclers
- `server/schemas/event-schemas.ts` - Single source of truth for all event types (Zod schemas)
- `server/config-validation/chronicler.schema.ts` - Zod validation schemas for chronicler configs
- `server/chroniclers/condition-evaluator.ts` - Condition evaluation logic
- `server/chroniclers/trigger-engine.ts` - Trigger engine implementations

## Event Schema Architecture

The system uses a **Zod-first approach** where all event types are defined as Zod schemas, and TypeScript types are automatically inferred from them. This ensures perfect consistency between runtime validation and compile-time type checking.

### Benefits

- **Single Source of Truth**: Event structures defined once in Zod schemas
- **Automatic Type Inference**: TypeScript types derived from schemas
- **Rich Validation**: Leverages Zod's validation capabilities (`.datetime()`, `.uuid()`, etc.)
- **Type Safety**: Discriminated unions provide compile-time safety
- **No Manual Synchronization**: Types and schemas always match

### Event Schema Location

All event schemas are defined in `server/schemas/event-schemas.ts`:
- 19 server event types with full Zod schemas
- Discriminated union for type-safe event handling
- Exported TypeScript types inferred from schemas
- Event type to data schema mapping for chronicler validation

## Trigger Types

### Event Trigger

Fires when specific events occur, optionally with conditions:

```json
{
  "type": "event",
  "on": ["assistant.action", "tool.result"],
  "conditions": [
    {
      "operator": "equals",
      "path": "action",
      "value": "tool_use"
    }
  ]
}
```

### Sequence Trigger

Fires when a pattern of events occurs:

```json
{
  "type": "sequence",
  "interestFilter": {
    "on": ["tool.result"]
  },
  "pattern": [
    {
      "type": "tool.result",
      "conditions": [
        {
          "operator": "equals",
          "path": "isError",
          "value": true
        }
      ]
    }
  ]
}
```

## Condition Operators

- `equals` / `notEquals` - Exact value matching
- `in` / `notIn` - Value in/not in array
- `contains` - String contains substring
- `matches` - Regex pattern matching
- `greaterThan` / `lessThan` - Numeric comparisons

## Execution Strategies

- **immediate** - Execute on every trigger match
- **debounce** - Wait for quiet period (milliseconds)
- **count** - Execute after N matches (threshold)
- **timeWindow** - Batch events within time window (milliseconds)

## Configuration Example

```json
{
  "id": "narrator",
  "name": "Narrator Chronicler",
  "description": "Provides human-readable summaries",
  "trigger": {
    "type": "event",
    "on": ["assistant.action", "tool.result"]
  },
  "execution": {
    "strategy": "debounce",
    "milliseconds": 2500
  },
  "promptTemplate": "Summarize: {{events}}",
  "model": "sonnet",
  "output": {
    "format": "text",
    "file": "narrator.log"
  }
}
```

## Path Validation

The system validates that condition paths are valid for the specified event types:

- Paths use dot notation: `"exitStatus.type"`
- Validation happens at configuration time
- Supports nested objects and union types
- Invalid paths are rejected with clear error messages

## Testing

### Unit Tests

```bash
bun test tests/unit/chronicler-validation.test.ts
bun test tests/unit/event-schema-sync.test.ts
```

### Integration Testing

The system can be tested against the real event journal to verify trigger behavior and timing.

## Integration Status

### Completed ✅
- Type definitions and interfaces
- Event schema generation system
- Configuration validation with Zod
- Condition evaluation logic
- Trigger engines (Event and Sequence)
- Comprehensive unit tests

### Not Yet Integrated ⏳
- ChroniclerManager (orchestrator)
- Individual Chronicler instances
- Integration with TadpoleServer
- LLM prompt execution
- Output file writing

## Development Guidelines

1. **Modify event schemas directly** in `server/schemas/event-schemas.ts` when adding/changing events
2. **Test path validation** when adding new event types
3. **Keep triggers simple** - complex logic belongs in the prompt
4. **Use appropriate execution strategies** to avoid overwhelming the LLM
5. **Handle errors gracefully** - chroniclers should never crash the main system

## Future Enhancements

- Support for more complex event patterns
- Custom aggregation functions
- Real-time UI updates for chronicler output
- Performance metrics and monitoring
- Dynamic chronicler loading/unloading
