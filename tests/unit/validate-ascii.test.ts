import { describe, expect, it } from "bun:test";
import type { Codon, CodonConfig, HankMeta, Loop } from "../../server/config.js";
import { renderHankStructure } from "../../server/validate-ascii.js";

// =============================================================================
// Mock Helpers
// =============================================================================

// IMPORTANT: mockCodon handles mutually exclusive fields (promptFile vs promptText)
// The Zod schema enforces that exactly one must be present.
// If overrides.promptFile is provided, we DON'T set promptText (and vice versa).
function mockCodon(overrides: Partial<Codon> = {}): Codon {
  const mockModel = {
    providerId: "anthropic",
    modelId: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    attachment: true,
    reasoning: false,
    tool_call: true,
    limit: { context: 200000, output: 8192 },
    modalities: { input: ["text"], output: ["text"] },
    release_date: "2024-10-22",
    last_updated: "2024-10-22",
    // biome-ignore lint/suspicious/noExplicitAny: Mock object - ModelInfo has many fields
  } as any;

  // Base defaults that are always set
  const baseDefaults: Partial<Codon> = {
    type: "codon",
    id: "test-codon",
    name: "Test Codon",
    model: mockModel,
    continuationMode: "fresh",
  };

  // Conditionally set promptText ONLY if promptFile is not provided in overrides
  const promptDefaults = overrides.promptFile ? {} : { promptText: "Test prompt" };

  return {
    ...baseDefaults,
    ...promptDefaults,
    ...overrides,
  } as Codon;
}

function mockLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    type: "loop",
    id: "test-loop",
    name: "Test Loop",
    terminateOn: { type: "iterationLimit", limit: 3 },
    codons: [mockCodon()],
    ...overrides,
  } as Loop;
}

function mockHankMeta(overrides: Partial<HankMeta> = {}): HankMeta {
  return {
    name: "Test Hank",
    version: "1.0.0",
    ...overrides,
  };
}

// Strip ANSI escape codes for assertions
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Required for ANSI escape sequence detection
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// =============================================================================
// Tests
// =============================================================================

describe("ASCII Renderer", () => {
  describe("renderHankStructure", () => {
    describe("basic rendering", () => {
      it("renders a single codon with correct structure", () => {
        const codons: CodonConfig[] = [mockCodon({ id: "analyze", name: "Analyze Data" })];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("analyze");
        expect(result).toContain("Analyze Data");
        expect(result).toContain("└─"); // Last item uses corner
      });

      it("renders multiple codons with correct tree structure", () => {
        const codons: CodonConfig[] = [
          mockCodon({ id: "first", name: "First" }),
          mockCodon({ id: "second", name: "Second" }),
          mockCodon({ id: "third", name: "Third" }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        // First two should use branch, last should use corner
        const lines = result.split("\n");
        const branchCount = lines.filter((l) => l.includes("├─")).length;
        const cornerCount = lines.filter((l) => l.includes("└─")).length;

        expect(branchCount).toBeGreaterThanOrEqual(2);
        expect(cornerCount).toBeGreaterThanOrEqual(1);
      });

      it("renders codon index numbers", () => {
        const codons: CodonConfig[] = [mockCodon({ id: "first" }), mockCodon({ id: "second" })];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("[1]");
        expect(result).toContain("[2]");
      });

      it("maintains correct order of codons", () => {
        const codons: CodonConfig[] = [
          mockCodon({ id: "alpha", name: "Alpha" }),
          mockCodon({ id: "beta", name: "Beta" }),
          mockCodon({ id: "gamma", name: "Gamma" }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        const alphaPos = result.indexOf("alpha");
        const betaPos = result.indexOf("beta");
        const gammaPos = result.indexOf("gamma");

        expect(alphaPos).toBeLessThan(betaPos);
        expect(betaPos).toBeLessThan(gammaPos);
      });
    });

    describe("loop rendering", () => {
      it("renders a loop with LOOP: marker and index number", () => {
        const codons: CodonConfig[] = [mockLoop({ id: "refine", name: "Refinement" })];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("[1] LOOP:");
        expect(result).toContain("refine");
        expect(result).toContain("Refinement");
      });

      it("renders iteration limit termination", () => {
        const codons: CodonConfig[] = [
          mockLoop({
            terminateOn: { type: "iterationLimit", limit: 5 },
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("× 5 iteration");
      });

      it("renders contextExceeded termination", () => {
        const codons: CodonConfig[] = [
          mockLoop({
            terminateOn: { type: "contextExceeded" },
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("context exceeded");
      });

      it("renders loop body with rounded box", () => {
        const codons: CodonConfig[] = [
          mockLoop({
            id: "my-loop",
            codons: [mockCodon({ id: "inner" })],
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("╭");
        expect(result).toContain("╰");
      });

      it("renders nested codons with hierarchical numbering", () => {
        const codons: CodonConfig[] = [
          mockCodon({ id: "first" }),
          mockLoop({
            id: "outer",
            codons: [mockCodon({ id: "inner-1" }), mockCodon({ id: "inner-2" })],
          }),
          mockCodon({ id: "last" }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("[1]");
        expect(result).toContain("[2] LOOP:");
        expect(result).toContain("[2.1]");
        expect(result).toContain("[2.2]");
        expect(result).toContain("[3]");
      });

      it("renders flow arrows between nested codons", () => {
        const codons: CodonConfig[] = [
          mockLoop({
            codons: [mockCodon({ id: "inner-1" }), mockCodon({ id: "inner-2" })],
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("↓");
      });

      it("renders multiple sequential loops with correct numbering", () => {
        const codons: CodonConfig[] = [
          mockLoop({ id: "loop-1", name: "First Loop" }),
          mockCodon({ id: "middle", name: "Middle Codon" }),
          mockLoop({ id: "loop-2", name: "Second Loop" }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("[1] LOOP:");
        expect(result).toContain("[2]");
        expect(result).toContain("[3] LOOP:");

        const firstLoopPos = result.indexOf("First Loop");
        const middlePos = result.indexOf("Middle Codon");
        const secondLoopPos = result.indexOf("Second Loop");

        expect(firstLoopPos).toBeLessThan(middlePos);
        expect(middlePos).toBeLessThan(secondLoopPos);
      });
    });

    describe("codon details", () => {
      it("shows model slug and friendly name when available", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            model: {
              providerId: "anthropic",
              modelId: "claude-3-5-haiku-20241022",
              name: "Claude 3.5 Haiku",
              attachment: true,
              reasoning: false,
              tool_call: true,
              limit: { context: 200000, output: 8192 },
              modalities: { input: ["text"], output: ["text"] },
              release_date: "2024-10-22",
              last_updated: "2024-10-22",
              // biome-ignore lint/suspicious/noExplicitAny: Mock object for testing
            } as any,
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        // Should show the slug "haiku" extracted from modelId
        expect(result).toContain("model: haiku");
      });

      it("shows continuation mode", () => {
        const codons: CodonConfig[] = [mockCodon({ continuationMode: "continue-previous" })];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("mode: continue");
      });

      it("shows fresh mode", () => {
        const codons: CodonConfig[] = [mockCodon({ continuationMode: "fresh" })];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("mode: fresh");
      });

      it("shows prompt count when promptFile is array", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            promptFile: ["./prompt1.md", "./prompt2.md"],
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("prompts: 2");
      });

      it("shows prompt count with line count when provided", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            id: "test-codon",
            promptFile: ["./prompt1.md", "./prompt2.md"],
          }),
        ];
        const promptLineCounts = new Map([["test-codon", 347]]);
        const result = renderHankStructure(codons, {
          useColor: false,
          promptLineCounts,
        });

        expect(result).toContain("prompts: 2 (347 lines)");
      });

      it("shows inline indicator with line count when using promptText", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            promptFile: undefined,
            promptText: "Line 1\nLine 2\nLine 3",
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("prompt: inline (3 lines)");
      });

      it("shows rig commands when present", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            rigSetup: [
              { type: "command", command: { run: "echo test" } },
              {
                type: "copy",
                copy: { from: "src/file.ts", to: "dest/file.ts" },
              },
              // biome-ignore lint/suspicious/noExplicitAny: Mock object for testing
            ] as any,
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        // Rig commands are shown on separate lines with details
        expect(result).toContain("rigs:");
        expect(result).toContain("cmd: echo test");
        expect(result).toContain("copy:");
      });

      it("shows checkpointedGlobs count when present", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            checkpointedFiles: ["src/**/*.ts", "tests/**/*.ts"],
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("checkpointedGlobs: 2");
      });

      it("shows sentinels count when present", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            sentinels: [
              { sentinelConfig: "./sentinel1.json" },
              { sentinelConfig: "./sentinel2.json" },
              // biome-ignore lint/suspicious/noExplicitAny: Mock object for testing
            ] as any,
          }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("sentinels: 2");
      });
    });

    describe("header box", () => {
      it("renders hank metadata when provided", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const result = renderHankStructure(codons, {
          hankMeta: mockHankMeta({ name: "My Workflow", version: "2.0.0" }),
          useColor: false,
        });

        expect(result).toContain("My Workflow");
        expect(result).toContain("v2.0.0");
      });

      it("shows default name when no metadata", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("Hank");
      });

      it("renders rounded corner box drawing characters", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).toContain("╭");
        expect(result).toContain("╮");
        expect(result).toContain("╰");
        expect(result).toContain("╯");
        expect(result).toContain("─");
        expect(result).toContain("│");
      });

      it("shows codon and loop counts", () => {
        const codons: CodonConfig[] = [
          mockCodon(),
          mockLoop({
            codons: [mockCodon(), mockCodon()],
          }),
          mockCodon(),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        // Total codons: 1 + 2 (in loop) + 1 = 4
        // Total loops: 1
        expect(result).toContain("4 codon");
        expect(result).toContain("1 loop");
      });

      it("shows global system prompt indicator when present", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const result = renderHankStructure(codons, {
          hasGlobalSystemPrompt: true,
          useColor: false,
        });

        expect(result).toContain("global system prompt");
      });
    });

    describe("flow arrows", () => {
      it("renders flow arrows between top-level codons", () => {
        const codons: CodonConfig[] = [
          mockCodon({ id: "first" }),
          mockCodon({ id: "second" }),
          mockCodon({ id: "third" }),
        ];
        const result = renderHankStructure(codons, { useColor: false });

        const arrowCount = (result.match(/↓/g) || []).length;
        expect(arrowCount).toBe(2);
      });

      it("does not render flow arrow after last item", () => {
        const codons: CodonConfig[] = [mockCodon({ id: "only-one" })];
        const result = renderHankStructure(codons, { useColor: false });

        expect(result).not.toContain("↓");
      });
    });

    describe("terminal width handling", () => {
      it("respects explicit terminalWidth option", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            name: "A Very Long Codon Name That Should Be Truncated",
          }),
        ];
        const result = renderHankStructure(codons, {
          terminalWidth: 50,
          useColor: false,
        });

        const lines = result.split("\n");
        for (const line of lines) {
          const visibleLength = stripAnsi(line).length;
          expect(visibleLength).toBeLessThanOrEqual(50);
        }
      });

      it("truncates long names with ellipsis", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            id: "very-long-codon-id-that-exceeds-normal-width",
            name: "A Very Long Codon Name That Definitely Exceeds Any Reasonable Width",
          }),
        ];
        const result = renderHankStructure(codons, {
          terminalWidth: 60,
          useColor: false,
        });

        expect(result).toContain("...");
      });

      it("handles narrow terminals gracefully (minimum width)", () => {
        const codons: CodonConfig[] = [mockCodon(), mockLoop()];
        expect(() => {
          renderHankStructure(codons, { terminalWidth: 30, useColor: false });
        }).not.toThrow();
      });

      it("uses 80 as default width when not specified", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const result = renderHankStructure(codons, { useColor: false });
        const lines = result.split("\n");

        for (const line of lines) {
          const visibleLength = stripAnsi(line).length;
          expect(visibleLength).toBeLessThanOrEqual(80);
        }
      });
    });

    describe("color output", () => {
      it("includes ANSI color codes when useColor is true", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const result = renderHankStructure(codons, { useColor: true });

        // biome-ignore lint/suspicious/noControlCharactersInRegex: Required for ANSI detection
        expect(result).toMatch(/\x1b\[/);
      });

      it("does not include ANSI color codes when useColor is false", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const result = renderHankStructure(codons, { useColor: false });

        // biome-ignore lint/suspicious/noControlCharactersInRegex: Required for ANSI detection
        expect(result).not.toMatch(/\x1b\[/);
      });

      it("outputs different results with and without colors", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const resultWithColor = renderHankStructure(codons, { useColor: true });
        const resultWithoutColor = renderHankStructure(codons, {
          useColor: false,
        });

        // Should be different (colored version has ANSI codes)
        expect(resultWithColor).not.toEqual(resultWithoutColor);

        // Stripping ANSI codes should produce similar structure
        // Note: May not be exactly equal due to truncation differences when ANSI codes affect length
        const strippedWithColor = stripAnsi(resultWithColor);
        // Both should contain the key elements
        expect(strippedWithColor).toContain("Hank");
        expect(strippedWithColor).toContain("test-codon");
        expect(strippedWithColor).toContain("Test Codon");
      });

      it("uses cyan for header box when colors enabled", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const result = renderHankStructure(codons, { useColor: true });

        expect(result).toContain("\x1b[36m");
      });

      it("uses yellow for loop markers when colors enabled", () => {
        const codons: CodonConfig[] = [mockLoop()];
        const result = renderHankStructure(codons, { useColor: true });

        expect(result).toContain("\x1b[33m");
      });

      it("uses green for model names when colors enabled", () => {
        const codons: CodonConfig[] = [mockCodon()];
        const result = renderHankStructure(codons, { useColor: true });

        expect(result).toContain("\x1b[32m");
      });

      it("uses blue for flow arrows when colors enabled", () => {
        const codons: CodonConfig[] = [mockCodon({ id: "first" }), mockCodon({ id: "second" })];
        const result = renderHankStructure(codons, { useColor: true });

        expect(result).toContain("\x1b[34m");
        expect(result).toContain("↓");
      });
    });

    describe("edge cases", () => {
      it("handles empty codons array", () => {
        const result = renderHankStructure([], { useColor: false });

        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
        expect(result).toContain("No codons");
      });

      it("handles codon with no optional fields", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            promptFile: undefined,
            promptText: "inline",
            rigSetup: undefined,
            checkpointedFiles: undefined,
            sentinels: undefined,
          }),
        ];

        expect(() => renderHankStructure(codons, { useColor: false })).not.toThrow();
      });

      it("handles unicode characters in names", () => {
        const codons: CodonConfig[] = [
          mockCodon({ name: "分析データ" }),
          mockCodon({ name: "Análisis de Datos" }),
        ];

        const result = renderHankStructure(codons, { useColor: false });
        expect(result).toContain("分析データ");
        expect(result).toContain("Análisis de Datos");
      });

      it("handles special characters in names", () => {
        const codons: CodonConfig[] = [
          mockCodon({ name: "Test & Validate" }),
          mockCodon({ name: "Check <output>" }),
        ];

        const result = renderHankStructure(codons, { useColor: false });
        expect(result).toContain("Test & Validate");
        expect(result).toContain("Check <output>");
      });

      it("handles very long single line without crashing", () => {
        const longName = "A".repeat(500);
        const codons: CodonConfig[] = [mockCodon({ name: longName })];

        expect(() => {
          renderHankStructure(codons, { terminalWidth: 80, useColor: false });
        }).not.toThrow();
      });

      it("handles codon with all optional fields populated", () => {
        const codons: CodonConfig[] = [
          mockCodon({
            id: "full",
            name: "Fully Loaded Codon",
            description: "This codon has everything",
            promptFile: ["./prompt1.md", "./prompt2.md", "./prompt3.md"],
            appendSystemPromptFile: "./system.md",
            rigSetup: [
              { type: "command", command: { run: "echo test" } },
              { type: "copy", copy: { from: "a", to: "b" } },
              // biome-ignore lint/suspicious/noExplicitAny: Mock object for testing
            ] as any,
            checkpointedFiles: ["src/**/*.ts", "tests/**/*.ts", "docs/**/*.md"],
            env: { DEBUG: "true" },
            // biome-ignore lint/suspicious/noExplicitAny: Mock object for testing
            sentinels: [{ sentinelConfig: "./sentinel.json" }] as any,
          }),
        ];

        const result = renderHankStructure(codons, {
          terminalWidth: 150,
          useColor: false,
        });
        expect(result).toContain("prompts: 3");
        expect(result).toContain("rigs:");
        expect(result).toContain("checkpointedGlobs: 3");
        expect(result).toContain("sentinels: 1");
      });

      it("handles large hank with 50+ codons (performance check)", () => {
        const codons: CodonConfig[] = [];

        for (let i = 0; i < 20; i++) {
          codons.push(mockCodon({ id: `codon-${i}`, name: `Codon ${i}` }));
        }

        for (let l = 0; l < 3; l++) {
          const loopCodons = Array.from({ length: 10 }, (_, i) =>
            mockCodon({
              id: `loop-${l}-codon-${i}`,
              name: `Loop ${l} Codon ${i}`,
            }),
          );
          codons.push(
            mockLoop({
              id: `loop-${l}`,
              name: `Loop ${l}`,
              codons: loopCodons,
            }),
          );
        }

        const startTime = performance.now();
        const result = renderHankStructure(codons, { useColor: false });
        const endTime = performance.now();

        expect(endTime - startTime).toBeLessThan(100);
        expect(result).toContain("50 codons");
        expect(result).toContain("3 loops");
        expect(result).toContain("codon-0");
        expect(result).toContain("codon-19");
        expect(result).toContain("loop-2-codon-9");
      });
    });
  });
});
