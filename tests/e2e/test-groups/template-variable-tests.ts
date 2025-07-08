import { expect, test } from "bun:test";
import type { AssistantActionEvent } from "../../../server/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runTemplateVariableTests(testState: TestState) {
  test("PROJECT_DIR template variable is replaced correctly", () => {
    // Check assistant messages for any unreplaced template variables
    const assistantActions = testState.client?.getEventsByType("assistant.action") || [];

    assistantActions.forEach((event) => {
      const action = event as AssistantActionEvent;
      const content = action.data?.content || "";

      // Should not contain unreplaced template variables
      expect(content).not.toContain("<%PROJECT_DIR%>");
      expect(content).not.toContain("<PROJECT_DIR>");
    });

    // Check that paths in tool inputs are properly resolved
    const toolUseActions = assistantActions.filter(
      (a) => (a as AssistantActionEvent).data?.action === "tool_use",
    );

    toolUseActions.forEach((action) => {
      const toolInput = (action as AssistantActionEvent).data?.toolInput;
      if (toolInput && typeof toolInput === "object") {
        const inputStr = JSON.stringify(toolInput);
        expect(inputStr).not.toContain("<%PROJECT_DIR%>");
      }
    });
  });
}
