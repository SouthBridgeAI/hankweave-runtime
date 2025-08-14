# Chronicler Trigger Configurations

This directory contains real-world chronicler configurations for testing and deployment. Each configuration represents a different monitoring and analysis use case.

## Available Chroniclers

### 1. **narrator.json** - Activity Narrator
- **Trigger**: All assistant actions and tool results
- **Strategy**: Debounce (3 seconds)
- **Purpose**: Provides human-readable summaries of agent activities
- **Output**: Text narrative log

### 2. **error-detector.json** - Error Pattern Detector
- **Trigger**: Sequence of 3 consecutive tool errors
- **Strategy**: Immediate
- **Purpose**: Detects repeated errors and analyzes patterns
- **Output**: JSON analysis with causes and fixes

### 3. **file-activity-monitor.json** - File Activity Monitor
- **Trigger**: File creation/modification events
- **Strategy**: Count (every 5 file operations)
- **Purpose**: Tracks and analyzes file system changes
- **Output**: JSON insights on file organization

### 4. **cost-tracker.json** - Cost and Token Tracker
- **Trigger**: Token usage events with cost > $0.50
- **Strategy**: Immediate
- **Purpose**: Alerts on high token usage and costs
- **Output**: JSON cost analysis

### 5. **thinking-analyzer.json** - Agent Thinking Analyzer
- **Trigger**: Agent thinking actions
- **Strategy**: Time window (30 seconds)
- **Purpose**: Identifies confusion, loops, or lack of progress
- **Output**: JSON analysis of thinking patterns

### 6. **phase-summary.json** - Phase Completion Summary
- **Trigger**: Phase completion events
- **Strategy**: Immediate
- **Purpose**: Comprehensive summary of completed phases
- **Output**: JSON phase analysis

### 7. **tool-usage-patterns.json** - Tool Usage Pattern Analyzer
- **Trigger**: Tool result events
- **Strategy**: Count (every 10 tool calls)
- **Purpose**: Analyzes tool usage efficiency and patterns
- **Output**: JSON pattern analysis

### 8. **rollback-monitor.json** - Rollback Activity Monitor
- **Trigger**: Sequence from rollback start to completion
- **Strategy**: Immediate
- **Purpose**: Documents and analyzes rollback operations
- **Output**: JSON rollback analysis

### 9. **stuck-detection.json** - Stuck Agent Detector
- **Trigger**: Sequence of repeated failed tool attempts
- **Strategy**: Immediate
- **Purpose**: Detects when agent is stuck in a loop
- **Output**: JSON stuck pattern analysis

## Trigger Types Used

### Event Triggers
- Simple event matching with optional conditions
- Used by: narrator, file-activity-monitor, cost-tracker, thinking-analyzer, phase-summary, tool-usage-patterns

### Sequence Triggers
- Pattern matching across multiple events
- Used by: error-detector, rollback-monitor, stuck-detection

## Execution Strategies

- **Immediate**: Executes as soon as trigger matches (error-detector, cost-tracker, phase-summary, rollback-monitor, stuck-detection)
- **Debounce**: Waits for quiet period (narrator - 3s)
- **Count**: Executes after N matches (file-activity-monitor - 5, tool-usage-patterns - 10)
- **Time Window**: Batches events within time period (thinking-analyzer - 30s)

## Condition Operators Demonstrated

- `equals`: Exact value matching (stuck-detection, thinking-analyzer, error-detector)
- `contains`: Substring matching (stuck-detection)
- `in`: Value in array (file-activity-monitor)
- `greaterThan`: Numeric comparison (cost-tracker)

## Testing

All configurations are validated by the test suite:

```bash
# Run validation tests
bun test tests/unit/chronicler-configs.test.ts

# Validate against real logs
# (Future: integration tests with websocket logs)
```

## Usage

These configurations can be:
1. Loaded into the ChroniclerManager when implemented
2. Used as templates for custom chroniclers
3. Modified for specific monitoring needs
4. Combined for comprehensive system observation

## Best Practices

1. **Choose appropriate triggers**: Event for simple monitoring, sequence for patterns
2. **Select right execution strategy**: Immediate for alerts, debounce for summaries
3. **Write clear prompts**: Be specific about what analysis you want
4. **Use appropriate output formats**: JSON for structured data, text for narratives
5. **Consider performance**: Don't trigger too frequently on high-volume events

## Future Enhancements

- Add chroniclers for:
  - Code quality analysis
  - Security vulnerability detection
  - Performance bottleneck identification
  - Test coverage monitoring
  - Documentation generation
