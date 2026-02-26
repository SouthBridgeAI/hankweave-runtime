import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFlagValue, parseCliArgs } from "../../server/cli-parser.js";

describe("getFlagValue", () => {
  let consoleWarnSpy: Array<string>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    consoleWarnSpy = [];
    originalWarn = console.warn;
    console.warn = (message: string) => {
      consoleWarnSpy.push(message);
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  describe("--flag value syntax (preferred)", () => {
    test("returns value when flag is present", () => {
      const args = ["--port", "8080"];
      expect(getFlagValue(args, "--port")).toBe("8080");
    });

    test("returns value when flag is in middle of args", () => {
      const args = ["--headless", "--port", "8080", "--model", "opus"];
      expect(getFlagValue(args, "--port")).toBe("8080");
    });

    test("returns value at end of args", () => {
      const args = ["--headless", "--port", "8080"];
      expect(getFlagValue(args, "--port")).toBe("8080");
    });

    test("handles multiple different flags", () => {
      const args = ["--port", "8080", "--model", "opus"];
      expect(getFlagValue(args, "--port")).toBe("8080");
      expect(getFlagValue(args, "--model")).toBe("opus");
    });

    test("does not warn for preferred syntax", () => {
      const args = ["--port", "8080"];
      getFlagValue(args, "--port");
      expect(consoleWarnSpy.length).toBe(0);
    });
  });

  describe("--flag=value syntax (deprecated)", () => {
    test("returns value using equals syntax", () => {
      const args = ["--port=8080"];
      expect(getFlagValue(args, "--port")).toBe("8080");
    });

    test("warns about deprecated syntax", () => {
      const args = ["--port=8080"];
      getFlagValue(args, "--port");
      expect(consoleWarnSpy.length).toBe(1);
      expect(consoleWarnSpy[0]).toContain("Deprecation warning");
      expect(consoleWarnSpy[0]).toContain("--port=8080");
      expect(consoleWarnSpy[0]).toContain("Use '--port <value>' instead");
    });

    test("handles equals syntax with complex value", () => {
      const args = ["--anthropic-base-url=https://api.example.com/v1"];
      expect(getFlagValue(args, "--anthropic-base-url")).toBe("https://api.example.com/v1");
    });

    test("handles equals syntax with empty value", () => {
      const args = ["--port="];
      expect(getFlagValue(args, "--port")).toBe("");
    });

    test("prefers equals syntax over space syntax when both present", () => {
      const args = ["--port=9999", "--port", "8080"];
      // Finds the equals version first
      expect(getFlagValue(args, "--port")).toBe("9999");
    });
  });

  describe("missing or invalid flags", () => {
    test("returns undefined when flag is not present", () => {
      const args = ["--headless", "--model", "opus"];
      expect(getFlagValue(args, "--port")).toBeUndefined();
    });

    test("returns undefined when flag is at end without value", () => {
      const args = ["--headless", "--port"];
      expect(getFlagValue(args, "--port")).toBeUndefined();
    });

    test("returns undefined when next arg is another flag", () => {
      const args = ["--port", "--headless"];
      expect(getFlagValue(args, "--port")).toBeUndefined();
    });

    test("returns undefined when next arg is another value flag", () => {
      const args = ["--port", "--model", "opus"];
      expect(getFlagValue(args, "--port")).toBeUndefined();
    });

    test("returns undefined for empty args array", () => {
      const args: string[] = [];
      expect(getFlagValue(args, "--port")).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    test("handles flag value that looks like a number", () => {
      const args = ["--model", "4090"];
      expect(getFlagValue(args, "--model")).toBe("4090");
    });

    test("handles flag value with special characters", () => {
      const args = ["--anthropic-base-url", "http://localhost:8080/api"];
      expect(getFlagValue(args, "--anthropic-base-url")).toBe("http://localhost:8080/api");
    });

    test("handles flag value with spaces when quoted (as single arg)", () => {
      const args = ["--model", "some model name"];
      expect(getFlagValue(args, "--model")).toBe("some model name");
    });

    test("does not match partial flag names", () => {
      const args = ["--port-number", "8080"];
      expect(getFlagValue(args, "--port")).toBeUndefined();
    });

    test("does not match substring in equals syntax", () => {
      const args = ["--port-number=8080"];
      expect(getFlagValue(args, "--port")).toBeUndefined();
    });
  });
});

describe("parseCliArgs", () => {
  let consoleWarnSpy: Array<string>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    consoleWarnSpy = [];
    originalWarn = console.warn;
    console.warn = (message: string) => {
      consoleWarnSpy.push(message);
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  // Tests with only positional args
  test("hankweave ./data (single non-.json arg treated as dataPath)", () => {
    const args = ["./data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBe("./data");
  });

  test("hankweave my-data-dir (single non-.json arg treated as dataPath)", () => {
    const args = ["my-data-dir"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBe("my-data-dir");
  });

  test("hankweave my-config.json (single .json arg treated as hankPath)", () => {
    const args = ["my-config.json"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("my-config.json");
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave ./path/to/config.json (single .json path treated as hankPath)", () => {
    const args = ["./path/to/config.json"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("./path/to/config.json");
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave my-hank.json ./data", () => {
    const args = ["my-hank.json", "./data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("my-hank.json");
    expect(result.dataPath).toBe("./data");
  });

  test("hankweave ./config/hank.json /path/to/data", () => {
    const args = ["./config/hank.json", "/path/to/data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("./config/hank.json");
    expect(result.dataPath).toBe("/path/to/data");
  });

  test("hankweave hank.json - (stdin)", () => {
    const args = ["hank.json", "-"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("hank.json");
    expect(result.dataPath).toBe("-");
  });

  test("hankweave https://github.com/user/repo (single remote URL treated as hankPath)", () => {
    const args = ["https://github.com/user/repo"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("https://github.com/user/repo");
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave git@github.com:user/repo (single SSH URL treated as hankPath)", () => {
    const args = ["git@github.com:user/repo"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("git@github.com:user/repo");
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave https://github.com/user/repo ./data (remote URL with data)", () => {
    const args = ["https://github.com/user/repo", "./data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("https://github.com/user/repo");
    expect(result.dataPath).toBe("./data");
  });

  // Tests with only flags
  test("hankweave --port 9090", () => {
    const args = ["--port", "9090"];
    const result = parseCliArgs(args);
    expect(result.port).toBe(9090);
    expect(typeof result.port).toBe("number");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --port=9090 (deprecated syntax)", () => {
    const args = ["--port=9090"];
    const result = parseCliArgs(args);
    expect(result.port).toBe(9090);
    expect(consoleWarnSpy.length).toBeGreaterThan(0);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --port invalid", () => {
    const args = ["--port", "invalid"];
    const result = parseCliArgs(args);
    expect(Number.isNaN(result.port)).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --model opus", () => {
    const args = ["--model", "opus"];
    const result = parseCliArgs(args);
    expect(result.model).toBe("opus");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --model sonnet", () => {
    const args = ["--model", "sonnet"];
    const result = parseCliArgs(args);
    expect(result.model).toBe("sonnet");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --model=opus (deprecated syntax)", () => {
    const args = ["--model=opus"];
    const result = parseCliArgs(args);
    expect(result.model).toBe("opus");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --model haiku (accepts any string)", () => {
    const args = ["--model", "haiku"];
    const result = parseCliArgs(args);
    expect(result.model).toBe("haiku");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --anthropic-base-url https://api.example.com", () => {
    const args = ["--anthropic-base-url", "https://api.example.com"];
    const result = parseCliArgs(args);
    expect(result.anthropicBaseUrl).toBe("https://api.example.com");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --anthropic-base-url=https://api.example.com/v1 (deprecated syntax)", () => {
    const args = ["--anthropic-base-url=https://api.example.com/v1"];
    const result = parseCliArgs(args);
    expect(result.anthropicBaseUrl).toBe("https://api.example.com/v1");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --no-autostart", () => {
    const args = ["--no-autostart"];
    const result = parseCliArgs(args);
    expect(result.autostart).toBe(false);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --no-autostart --port 8080", () => {
    const args = ["--no-autostart", "--port", "8080"];
    const result = parseCliArgs(args);
    expect(result.autostart).toBe(false);
    expect(result.port).toBe(8080);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --proxy", () => {
    const args = ["--proxy"];
    const result = parseCliArgs(args);
    expect(result.withoutProxy).toBe(false);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --without-proxy", () => {
    const args = ["--without-proxy"];
    const result = parseCliArgs(args);
    expect(result.withoutProxy).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --proxy --without-proxy (--without-proxy wins)", () => {
    const args = ["--proxy", "--without-proxy"];
    const result = parseCliArgs(args);
    // Implementation uses includes(), --without-proxy is checked last in code
    expect(result.withoutProxy).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --without-proxy --proxy (--without-proxy still wins)", () => {
    const args = ["--without-proxy", "--proxy"];
    const result = parseCliArgs(args);
    // Implementation uses includes(), not arg order, so --without-proxy wins
    expect(result.withoutProxy).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --idle-timeout 120", () => {
    const args = ["--idle-timeout", "120"];
    const result = parseCliArgs(args);
    expect(result.idleTimeout).toBe(120);
    expect(typeof result.idleTimeout).toBe("number");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --idle-timeout=60 (deprecated syntax)", () => {
    const args = ["--idle-timeout=60"];
    const result = parseCliArgs(args);
    expect(result.idleTimeout).toBe(60);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --idle-timeout invalid throws", () => {
    const args = ["--idle-timeout", "invalid"];
    expect(() => parseCliArgs(args)).toThrow("Invalid --idle-timeout value");
  });

  test("hankweave --idle-timeout 0 throws", () => {
    const args = ["--idle-timeout", "0"];
    expect(() => parseCliArgs(args)).toThrow("Invalid --idle-timeout value");
  });

  test("hankweave --idle-timeout 256 throws (exceeds max)", () => {
    const args = ["--idle-timeout", "256"];
    expect(() => parseCliArgs(args)).toThrow("Invalid --idle-timeout value");
  });

  test("hankweave --idle-timeout -5 throws (treated as missing value)", () => {
    const args = ["--idle-timeout", "-5"];
    expect(() => parseCliArgs(args)).toThrow("requires a value");
  });

  test("hankweave --shim-idle-timeout 30", () => {
    const args = ["--shim-idle-timeout", "30"];
    const result = parseCliArgs(args);
    expect(result.shimIdleTimeout).toBe(30);
    expect(typeof result.shimIdleTimeout).toBe("number");
  });

  test("hankweave --shim-idle-timeout invalid throws", () => {
    const args = ["--shim-idle-timeout", "invalid"];
    expect(() => parseCliArgs(args)).toThrow("Invalid --shim-idle-timeout value");
  });

  test("hankweave --shim-idle-timeout 0 throws", () => {
    const args = ["--shim-idle-timeout", "0"];
    expect(() => parseCliArgs(args)).toThrow("Invalid --shim-idle-timeout value");
  });

  test("hankweave --shim-idle-timeout 601 throws (exceeds max)", () => {
    const args = ["--shim-idle-timeout", "601"];
    expect(() => parseCliArgs(args)).toThrow("Invalid --shim-idle-timeout value");
  });

  test("hankweave --shim-idle-timeout -5 throws (treated as missing value)", () => {
    const args = ["--shim-idle-timeout", "-5"];
    expect(() => parseCliArgs(args)).toThrow("requires a value");
  });

  test("hankweave --port 9090 --model opus --anthropic-base-url https://api.example.com --no-autostart --proxy --idle-timeout 120 --shim-idle-timeout 45", () => {
    const args = [
      "--port",
      "9090",
      "--model",
      "opus",
      "--anthropic-base-url",
      "https://api.example.com",
      "--no-autostart",
      "--proxy",
      "--idle-timeout",
      "120",
      "--shim-idle-timeout",
      "45",
    ];
    const result = parseCliArgs(args);

    expect(result.port).toBe(9090);
    expect(result.model).toBe("opus");
    expect(result.anthropicBaseUrl).toBe("https://api.example.com");
    expect(result.autostart).toBe(false);
    expect(result.withoutProxy).toBe(false);
    expect(result.idleTimeout).toBe(120);
    expect(result.shimIdleTimeout).toBe(45);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --port=8080 --model sonnet --idle-timeout=60 (mixed syntax)", () => {
    const args = ["--port=8080", "--model", "sonnet", "--idle-timeout=60"];
    const result = parseCliArgs(args);

    expect(result.port).toBe(8080);
    expect(result.model).toBe("sonnet");
    expect(result.idleTimeout).toBe(60);
    expect(consoleWarnSpy.length).toBe(2); // Two deprecated flags
  });

  test("hankweave --no-autostart --model opus --port 7777 (any order)", () => {
    const args = ["--no-autostart", "--model", "opus", "--port", "7777"];
    const result = parseCliArgs(args);

    expect(result.autostart).toBe(false);
    expect(result.model).toBe("opus");
    expect(result.port).toBe(7777);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave (no args)", () => {
    const args: string[] = [];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
    expect(result.port).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  test("hankweave (no recognized flags, no positionals)", () => {
    const args: string[] = [];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
    expect(result.port).toBeUndefined();
  });

  test("hankweave --port 8080 --model opus (complete values)", () => {
    const args = ["--port", "8080", "--model", "opus"];
    const result = parseCliArgs(args);
    expect(result.port).toBe(8080);
    expect(result.model).toBe("opus");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --port 8080 (only sets present flags)", () => {
    const args = ["--port", "8080"];
    const result = parseCliArgs(args);

    expect("port" in result).toBe(true);
    expect("model" in result).toBe(false);
    expect("anthropicBaseUrl" in result).toBe(false);
    expect("autostart" in result).toBe(false);
    expect("withoutProxy" in result).toBe(false);
    expect("idleTimeout" in result).toBe(false);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --port 8080 --model opus (return type validation)", () => {
    const args = ["--port", "8080", "--model", "opus"];
    const result = parseCliArgs(args);

    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --port 8080 --model opus --anthropic-base-url https://api.example.com --no-autostart --proxy --idle-timeout 120 (type validation)", () => {
    const args = [
      "--port",
      "8080",
      "--model",
      "opus",
      "--anthropic-base-url",
      "https://api.example.com",
      "--no-autostart",
      "--proxy",
      "--idle-timeout",
      "120",
    ];
    const result = parseCliArgs(args);

    if (result.port !== undefined) {
      expect(typeof result.port).toBe("number");
    }
    if (result.model !== undefined) {
      expect(typeof result.model).toBe("string");
    }
    if (result.anthropicBaseUrl !== undefined) {
      expect(typeof result.anthropicBaseUrl).toBe("string");
    }
    if (result.autostart !== undefined) {
      expect(typeof result.autostart).toBe("boolean");
    }
    if (result.withoutProxy !== undefined) {
      expect(typeof result.withoutProxy).toBe("boolean");
    }
    if (result.idleTimeout !== undefined) {
      expect(typeof result.idleTimeout).toBe("number");
    }
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --port=8080 (warns for deprecated syntax)", () => {
    const args = ["--port=8080"];
    const result = parseCliArgs(args);
    expect(consoleWarnSpy.length).toBeGreaterThan(0);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --port 8080 --model opus (no warnings for preferred syntax)", () => {
    const args = ["--port", "8080", "--model", "opus"];
    const result = parseCliArgs(args);
    expect(consoleWarnSpy.length).toBe(0);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --port=8080 --model=opus --idle-timeout=60 (multiple deprecation warnings)", () => {
    const args = ["--port=8080", "--model=opus", "--idle-timeout=60"];
    const result = parseCliArgs(args);
    expect(consoleWarnSpy.length).toBe(3);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  // Combined tests: positional args + flags
  test("hankweave my-hank.json ./data --port 8080", () => {
    const args = ["my-hank.json", "./data", "--port", "8080"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("my-hank.json");
    expect(result.dataPath).toBe("./data");
    expect(result.port).toBe(8080);
  });

  test("hankweave --port 8080 my-hank.json ./data", () => {
    const args = ["--port", "8080", "my-hank.json", "./data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("my-hank.json");
    expect(result.dataPath).toBe("./data");
    expect(result.port).toBe(8080);
  });

  test("hankweave my-hank.json --port 8080 ./data", () => {
    const args = ["my-hank.json", "--port", "8080", "./data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("my-hank.json");
    expect(result.dataPath).toBe("./data");
    expect(result.port).toBe(8080);
  });

  test("hankweave --headless my-hank.json --no-autostart ./data --model opus", () => {
    const args = ["--headless", "my-hank.json", "--no-autostart", "./data", "--model", "opus"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("my-hank.json");
    expect(result.dataPath).toBe("./data");
    expect(result.model).toBe("opus");
    expect(result.autostart).toBe(false);
  });

  test("hankweave --port=8080 my-hank.json --model=opus ./data", () => {
    const args = ["--port=8080", "my-hank.json", "--model=opus", "./data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("my-hank.json");
    expect(result.dataPath).toBe("./data");
    expect(result.port).toBe(8080);
    expect(result.model).toBe("opus");
  });

  test("hankweave --config my-hank.json --data ./data (flags instead of positional)", () => {
    const args = ["--config", "my-hank.json", "--data", "./data"];
    const result = parseCliArgs(args);
    // Should not extract flag values as positional args
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave my-hank.json --config other.json ./data", () => {
    const args = ["my-hank.json", "--config", "other.json", "./data"];
    const result = parseCliArgs(args);
    // Positional args are extracted, flag value is not
    expect(result.hankPath).toBe("my-hank.json");
    expect(result.dataPath).toBe("./data");
  });

  test("hankweave hank.json --anthropic-base-url https://api.example.com ./data", () => {
    const args = ["hank.json", "--anthropic-base-url", "https://api.example.com", "./data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("hank.json");
    expect(result.dataPath).toBe("./data");
    expect(result.anthropicBaseUrl).toBe("https://api.example.com");
  });

  test("hankweave --execution /path/to/exec hank.json ./data", () => {
    const args = ["--execution", "/path/to/exec", "hank.json", "./data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("hank.json");
    expect(result.dataPath).toBe("./data");
  });

  test("hankweave hank.json ./data --input 'some text'", () => {
    const args = ["hank.json", "./data", "--input", "some text"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("hank.json");
    expect(result.dataPath).toBe("./data");
  });

  test("hankweave my-hank.json ./data --idle-timeout 120 --port 9090", () => {
    const args = ["my-hank.json", "./data", "--idle-timeout", "120", "--port", "9090"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("my-hank.json");
    expect(result.dataPath).toBe("./data");
    expect(result.idleTimeout).toBe(120);
    expect(result.port).toBe(9090);
  });

  test("hankweave --headless --proxy --no-autostart hank.json data-dir", () => {
    const args = ["--headless", "--proxy", "--no-autostart", "hank.json", "data-dir"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("hank.json");
    expect(result.dataPath).toBe("data-dir");
    expect(result.withoutProxy).toBe(false);
    expect(result.autostart).toBe(false);
  });

  test("hankweave path/with spaces.json path/with spaces/data", () => {
    const args = ["path/with spaces.json", "path/with spaces/data"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("path/with spaces.json");
    expect(result.dataPath).toBe("path/with spaces/data");
  });

  test("hankweave first.json second (two positional args)", () => {
    const args = ["first.json", "second"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("first.json");
    expect(result.dataPath).toBe("second");
  });

  test("hankweave my-hank.json ./data --port 9090 --model opus --no-autostart --proxy", () => {
    const args = [
      "my-hank.json",
      "./data",
      "--port",
      "9090",
      "--model",
      "opus",
      "--no-autostart",
      "--proxy",
    ];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("my-hank.json");
    expect(result.dataPath).toBe("./data");
    expect(result.port).toBe(9090);
    expect(result.model).toBe("opus");
    expect(result.autostart).toBe(false);
    expect(result.withoutProxy).toBe(false);
  });

  // Tests for additional value flags
  test("hankweave --config my-config.json", () => {
    const args = ["--config", "my-config.json"];
    const result = parseCliArgs(args);
    expect(result.configPath).toBe("my-config.json");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --data ./my-data", () => {
    const args = ["--data", "./my-data"];
    const result = parseCliArgs(args);
    expect(result.dataFlag).toBe("./my-data");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --execution /path/to/exec", () => {
    const args = ["--execution", "/path/to/exec"];
    const result = parseCliArgs(args);
    expect(result.executionPath).toBe("/path/to/exec");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --input 'some text here'", () => {
    const args = ["--input", "some text here"];
    const result = parseCliArgs(args);
    expect(result.inputText).toBe("some text here");
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  // Tests for additional boolean flags
  test("hankweave --headless", () => {
    const args = ["--headless"];
    const result = parseCliArgs(args);
    expect(result.headless).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --validate", () => {
    const args = ["--validate"];
    const result = parseCliArgs(args);
    expect(result.validate).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave -v (validate shorthand)", () => {
    const args = ["-v"];
    const result = parseCliArgs(args);
    expect(result.validate).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --cleanup", () => {
    const args = ["--cleanup"];
    const result = parseCliArgs(args);
    expect(result.cleanup).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave -y (skip confirmation)", () => {
    const args = ["-y"];
    const result = parseCliArgs(args);
    expect(result.skipConfirmation).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --start-new", () => {
    const args = ["--start-new"];
    const result = parseCliArgs(args);
    expect(result.startNew).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --force", () => {
    const args = ["--force"];
    const result = parseCliArgs(args);
    expect(result.force).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --init", () => {
    const args = ["--init"];
    const result = parseCliArgs(args);
    expect(result.init).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --help", () => {
    const args = ["--help"];
    const result = parseCliArgs(args);
    expect(result.help).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave -h (help shorthand)", () => {
    const args = ["-h"];
    const result = parseCliArgs(args);
    expect(result.help).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --version", () => {
    const args = ["--version"];
    const result = parseCliArgs(args);
    expect(result.showVersion).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --copy", () => {
    const args = ["--copy"];
    const result = parseCliArgs(args);
    expect(result.copy).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --ignore-data-mismatch", () => {
    const args = ["--ignore-data-mismatch"];
    const result = parseCliArgs(args);
    expect(result.ignoreDataMismatch).toBe(true);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBeUndefined();
  });

  test("hankweave --ignore-data-mismatch with --execution", () => {
    const args = ["--execution", "/path/to/exec", "--ignore-data-mismatch"];
    const result = parseCliArgs(args);
    expect(result.executionPath).toBe("/path/to/exec");
    expect(result.ignoreDataMismatch).toBe(true);
  });

  // Complex combination test
  test("hankweave ./data --headless --validate --port 8080 -y", () => {
    const args = ["./data", "--headless", "--validate", "--port", "8080", "-y"];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBeUndefined();
    expect(result.dataPath).toBe("./data");
    expect(result.headless).toBe(true);
    expect(result.validate).toBe(true);
    expect(result.port).toBe(8080);
    expect(result.skipConfirmation).toBe(true);
  });

  test("hankweave hank.json ./data --config other.json --data /other/data --headless --force", () => {
    const args = [
      "hank.json",
      "./data",
      "--config",
      "other.json",
      "--data",
      "/other/data",
      "--headless",
      "--force",
    ];
    const result = parseCliArgs(args);
    expect(result.hankPath).toBe("hank.json");
    expect(result.dataPath).toBe("./data");
    expect(result.configPath).toBe("other.json");
    expect(result.dataFlag).toBe("/other/data");
    expect(result.headless).toBe(true);
    expect(result.force).toBe(true);
  });

  // Validation error tests
  describe("validation errors", () => {
    test("throws on unknown flag", () => {
      const args = ["--unknown-flag"];
      expect(() => parseCliArgs(args)).toThrow(
        "Unknown argument '--unknown-flag'. Run with --help for available options.",
      );
    });

    test("throws on unknown flag with value", () => {
      const args = ["--unknown", "value"];
      expect(() => parseCliArgs(args)).toThrow(
        "Unknown argument '--unknown'. Run with --help for available options.",
      );
    });

    test("throws on unknown flag with equals syntax", () => {
      const args = ["--unknown=value"];
      expect(() => parseCliArgs(args)).toThrow(
        "Unknown argument '--unknown=value'. Run with --help for available options.",
      );
    });

    test("throws when boolean flag has value (equals syntax)", () => {
      const args = ["--headless=true"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--headless' does not take a value.");
    });

    test("throws when boolean flag --validate has value", () => {
      const args = ["--validate=true"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--validate' does not take a value.");
    });

    test("throws when boolean flag -v has value", () => {
      const args = ["-v=something"];
      expect(() => parseCliArgs(args)).toThrow("Flag '-v' does not take a value.");
    });

    test("throws when boolean flag --init has value", () => {
      const args = ["--init=project"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--init' does not take a value.");
    });

    test("throws when boolean flag --version has value", () => {
      const args = ["--version=1.0.0"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--version' does not take a value.");
    });

    test("throws when value flag has no value (end of args)", () => {
      const args = ["--port"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--port' requires a value.");
    });

    test("throws when value flag has no value (next is flag)", () => {
      const args = ["--port", "--headless"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--port' requires a value.");
    });

    test("throws when --model has no value", () => {
      const args = ["--model"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--model' requires a value.");
    });

    test("throws when --config has no value", () => {
      const args = ["--config"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--config' requires a value.");
    });

    test("throws when --data has no value", () => {
      const args = ["--data", "--port", "8080"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--data' requires a value.");
    });

    test("throws when --anthropic-base-url has no value", () => {
      const args = ["--anthropic-base-url"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--anthropic-base-url' requires a value.");
    });

    test("throws when too many positional arguments (3)", () => {
      const args = ["first", "second", "third"];
      expect(() => parseCliArgs(args)).toThrow(
        "Too many positional arguments. Expected at most 2 (hank-path, data-path), got 3.",
      );
    });

    test("throws when too many positional arguments (4)", () => {
      const args = ["first", "second", "third", "fourth"];
      expect(() => parseCliArgs(args)).toThrow(
        "Too many positional arguments. Expected at most 2 (hank-path, data-path), got 4.",
      );
    });

    test("throws when too many positional arguments with flags mixed", () => {
      const args = ["first", "--port", "8080", "second", "third"];
      expect(() => parseCliArgs(args)).toThrow(
        "Too many positional arguments. Expected at most 2 (hank-path, data-path), got 3.",
      );
    });

    test("validation happens before parsing (unknown flag stops early)", () => {
      const args = ["--unknown", "--port", "8080"];
      expect(() => parseCliArgs(args)).toThrow("Unknown argument '--unknown'");
    });

    test("validation happens before parsing (boolean with value stops early)", () => {
      const args = ["--headless=true", "--port", "8080"];
      expect(() => parseCliArgs(args)).toThrow("Flag '--headless' does not take a value.");
    });
  });

  // ENG-119: --ignore-rig-failures flag tests
  describe("--ignore-rig-failures flag (ENG-119)", () => {
    test("should parse --ignore-rig-failures flag", () => {
      const args = ["--ignore-rig-failures", "hank.json", "./data"];
      const result = parseCliArgs(args);
      expect(result.ignoreRigFailures).toBe(true);
    });

    test("should default ignoreRigFailures to false/undefined", () => {
      const args = ["hank.json", "./data"];
      const result = parseCliArgs(args);
      expect(result.ignoreRigFailures).toBeFalsy();
    });

    test("should work with other flags", () => {
      const args = ["--ignore-rig-failures", "--port", "8080", "hank.json"];
      const result = parseCliArgs(args);
      expect(result.ignoreRigFailures).toBe(true);
      expect(result.port).toBe(8080);
    });

    // [P2] Avoid overriding config with false when flag absent
    // When --ignore-rig-failures is not provided, the property should not be set
    // (similar to --no-autostart behavior). This allows hankweave.json/env values
    // to take effect, since CLI args are the highest-precedence layer.
    test("should not set ignoreRigFailures property when flag is absent", () => {
      const args = ["hank.json", "./data"];
      const result = parseCliArgs(args);
      // The property should not exist in the result object
      expect("ignoreRigFailures" in result).toBe(false);
      expect(result.ignoreRigFailures).toBeUndefined();
    });

    test("should not set ignoreRigFailures even with other flags present", () => {
      const args = ["--port", "8080", "--model", "opus", "hank.json"];
      const result = parseCliArgs(args);
      // The property should not exist in the result object
      expect("ignoreRigFailures" in result).toBe(false);
      expect(result.ignoreRigFailures).toBeUndefined();
    });
  });

  // ENG-103: --attach flag tests
  describe("--attach flag (ENG-103)", () => {
    test("should parse --attach flag", () => {
      const args = ["--attach"];
      const result = parseCliArgs(args);
      expect(result.attach).toBe(true);
    });

    test("should parse --attach with --port", () => {
      const args = ["--attach", "--port", "9999"];
      const result = parseCliArgs(args);
      expect(result.attach).toBe(true);
      expect(result.port).toBe(9999);
    });

    test("should parse --attach with --execution", () => {
      const args = ["--attach", "--execution", "/path/to/exec"];
      const result = parseCliArgs(args);
      expect(result.attach).toBe(true);
      expect(result.executionPath).toBe("/path/to/exec");
    });

    test("should default attach to false/undefined", () => {
      const args = ["hank.json", "./data"];
      const result = parseCliArgs(args);
      expect(result.attach).toBeFalsy();
    });
  });

  describe("--overwrite-output flag", () => {
    test("should parse --overwrite-output flag", () => {
      const args = ["--overwrite-output", "hank.json"];
      const result = parseCliArgs(args);
      expect(result.overwriteOutput).toBe(true);
    });

    test("should default overwriteOutput to false/undefined", () => {
      const args = ["hank.json", "./data"];
      const result = parseCliArgs(args);
      expect(result.overwriteOutput).toBeFalsy();
    });

    test("should work with --output flag", () => {
      const args = ["--output", "./results", "--overwrite-output", "hank.json"];
      const result = parseCliArgs(args);
      expect(result.outputPath).toBe("./results");
      expect(result.overwriteOutput).toBe(true);
    });
  });

  describe("--output flag", () => {
    test("should parse --output flag with path", () => {
      const args = ["--output", "./results", "hank.json"];
      const result = parseCliArgs(args);
      expect(result.outputPath).toBe("./results");
    });

    test("should parse --output flag with absolute path", () => {
      const args = ["--output", "/tmp/hankweave-output"];
      const result = parseCliArgs(args);
      expect(result.outputPath).toBe("/tmp/hankweave-output");
    });

    test("should default outputPath to undefined", () => {
      const args = ["hank.json", "./data"];
      const result = parseCliArgs(args);
      expect(result.outputPath).toBeUndefined();
    });

    test("should work with other flags", () => {
      const args = ["--output", "./results", "--port", "8080", "hank.json"];
      const result = parseCliArgs(args);
      expect(result.outputPath).toBe("./results");
      expect(result.port).toBe(8080);
    });
  });

  describe("short aliases", () => {
    test("-p should work as --port", () => {
      const result = parseCliArgs(["-p", "9000"]);
      expect(result.port).toBe(9000);
    });

    test("-o should work as --output", () => {
      const result = parseCliArgs(["-o", "./out"]);
      expect(result.outputPath).toBe("./out");
    });

    test("-e should work as --execution", () => {
      const result = parseCliArgs(["-e", "/path/to/exec"]);
      expect(result.executionPath).toBe("/path/to/exec");
    });

    test("-i should work as --input", () => {
      const result = parseCliArgs(["-i", "some text"]);
      expect(result.inputText).toBe("some text");
    });

    test("-m should work as --model", () => {
      const result = parseCliArgs(["-m", "opus"]);
      expect(result.model).toBe("opus");
    });

    test("-n should work as --start-new", () => {
      const result = parseCliArgs(["-n"]);
      expect(result.startNew).toBe(true);
    });

    test("--new should work as --start-new", () => {
      const result = parseCliArgs(["--new"]);
      expect(result.startNew).toBe(true);
    });

    test("-f should work as --force", () => {
      const result = parseCliArgs(["-f"]);
      expect(result.force).toBe(true);
    });

    test("combining short flags: -n -f -e ./exec -m opus -p 8080", () => {
      const result = parseCliArgs(["-n", "-f", "-e", "./exec", "-m", "opus", "-p", "8080"]);
      expect(result.startNew).toBe(true);
      expect(result.force).toBe(true);
      expect(result.executionPath).toBe("./exec");
      expect(result.model).toBe("opus");
      expect(result.port).toBe(8080);
    });
  });
});
