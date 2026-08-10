import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultProfileDefinesRegion,
  detectInstanceMetadataCredentials,
} from "../../server/aws-credentials";
import {
  ClaudeAgentSDKManager,
  claudeSettingsDefineAwsCredentialHelpers,
  DEFAULT_SDK_IDLE_TIMEOUT_SECONDS,
  describeAmbientAwsCredentialSource,
} from "../../server/claude-agent-sdk-manager";
import { ClaudeLogParser } from "../../server/claude-log-parser";
import { classifyApiErrorText } from "../../server/error-classification";
import { IdleTimeoutError, Logger } from "../../server/utils";

/**
 * A file-backed AWS source must mean a usable selected/default profile, not a
 * merely existing file: a config holding only a region, or only profiles
 * unrelated to AWS_PROFILE, selects no credentials — preflight passing on it
 * would defer the failure to the first codon invoke.
 */
describe("describeAmbientAwsCredentialSource profile inspection", () => {
  const ENV_KEYS = [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_PROFILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
  ];
  const savedEnv: Record<string, string | undefined> = {};
  let awsDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    awsDir = fs.mkdtempSync(path.join(os.tmpdir(), "aws-cred-source-test-"));
    // Point both files into the temp dir so the developer's real ~/.aws never
    // leaks into the assertions; individual tests write what they need.
    process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(awsDir, "credentials");
    process.env.AWS_CONFIG_FILE = path.join(awsDir, "config");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    rmSync(awsDir, { recursive: true, force: true });
  });

  test("config file with only a region is not a credential source", () => {
    fs.writeFileSync(path.join(awsDir, "config"), "[default]\nregion = eu-central-1\n");
    expect(describeAmbientAwsCredentialSource()).toBeNull();
  });

  test("credentials file with a default key pair is a credential source", () => {
    fs.writeFileSync(
      path.join(awsDir, "credentials"),
      "[default]\naws_access_key_id = AKIA123\naws_secret_access_key = secret\n",
    );
    expect(describeAmbientAwsCredentialSource()).toContain("credentials file");
  });

  test("config-only default SSO profile is a credential source", () => {
    fs.writeFileSync(
      path.join(awsDir, "config"),
      "[default]\nsso_session = corp\nsso_account_id = 123456789012\n",
    );
    expect(describeAmbientAwsCredentialSource()).toContain("config file");
  });

  test("AWS_PROFILE naming a configured profile is a credential source", () => {
    process.env.AWS_PROFILE = "work";
    fs.writeFileSync(
      path.join(awsDir, "config"),
      "[profile work]\nsso_start_url = https://corp.awsapps.com/start\nregion = us-west-2\n",
    );
    expect(describeAmbientAwsCredentialSource()).toBe("AWS_PROFILE (work)");
  });

  test("aws login profile (login_session selector only) is a credential source", () => {
    process.env.AWS_PROFILE = "work";
    fs.writeFileSync(
      path.join(awsDir, "config"),
      "[profile work]\nlogin_session = corp-login\nregion = us-west-2\n",
    );
    expect(describeAmbientAwsCredentialSource()).toBe("AWS_PROFILE (work)");
  });

  test("defaultProfileDefinesRegion: true for a region-only [default], false without one", () => {
    // Region resolution is independent of the credential source: a [default]
    // holding only a region must still keep the fallback region from being
    // pinned over it, even when credentials come from env/ECS/IMDS.
    expect(defaultProfileDefinesRegion()).toBe(false);
    fs.writeFileSync(
      path.join(awsDir, "credentials"),
      "[default]\naws_access_key_id = AKIA123\naws_secret_access_key = secret\n",
    );
    expect(defaultProfileDefinesRegion()).toBe(false);
    fs.writeFileSync(path.join(awsDir, "config"), "[default]\nregion = eu-central-1\n");
    expect(defaultProfileDefinesRegion()).toBe(true);
  });

  test("defaultProfileDefinesRegion ignores regions in named profiles", () => {
    fs.writeFileSync(path.join(awsDir, "config"), "[profile other]\nregion = eu-central-1\n");
    expect(defaultProfileDefinesRegion()).toBe(false);
  });

  test("an env key pair is not a credential source while AWS_PROFILE is set", () => {
    // The Node SDK skips fromEnv entirely when AWS_PROFILE is set, so a valid
    // key pair next to a broken profile must not pass preflight — the child
    // would ignore the pair and fail on its first request.
    process.env.AWS_PROFILE = "missing";
    process.env.AWS_ACCESS_KEY_ID = "AKIA123";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    expect(describeAmbientAwsCredentialSource()).toBeNull();

    // With the profile usable, it wins over the pair — mirroring the SDK.
    fs.writeFileSync(
      path.join(awsDir, "config"),
      "[profile missing]\nsso_session = corp\nsso_account_id = 123456789012\n",
    );
    expect(describeAmbientAwsCredentialSource()).toBe("AWS_PROFILE (missing)");

    // Without a profile selected, the pair is the source again.
    delete process.env.AWS_PROFILE;
    expect(describeAmbientAwsCredentialSource()).toBe("AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY");
  });

  test("AWS_PROFILE naming a missing profile is not a credential source", () => {
    process.env.AWS_PROFILE = "missing";
    fs.writeFileSync(
      path.join(awsDir, "credentials"),
      "[other]\naws_access_key_id = AKIA123\naws_secret_access_key = secret\n",
    );
    expect(describeAmbientAwsCredentialSource()).toBeNull();
  });

  test("an unusable AWS_PROFILE still lets container credentials through", () => {
    process.env.AWS_PROFILE = "missing";
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/uuid";
    expect(describeAmbientAwsCredentialSource()).toBe("ECS container credentials");
  });

  test("unrelated named profiles don't satisfy the default lookup", () => {
    fs.writeFileSync(
      path.join(awsDir, "config"),
      "[profile other]\naws_access_key_id = AKIA123\n[default]\noutput = json\n",
    );
    expect(describeAmbientAwsCredentialSource()).toBeNull();
  });
});

describe("Agent-managed Bedrock auth detection", () => {
  let configDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-test-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (saved.CLAUDE_CONFIG_DIR !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  test("no settings file → no credential helpers", () => {
    expect(claudeSettingsDefineAwsCredentialHelpers()).toBe(false);
  });

  test("settings without AWS helpers → false", () => {
    fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    expect(claudeSettingsDefineAwsCredentialHelpers()).toBe(false);
  });

  test("awsCredentialExport in settings → true", () => {
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ awsCredentialExport: "/opt/aws/export-creds.sh" }),
    );
    expect(claudeSettingsDefineAwsCredentialHelpers()).toBe(true);
  });

  test("awsAuthRefresh in settings → true", () => {
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ awsAuthRefresh: "aws sso login --profile bedrock" }),
    );
    expect(claudeSettingsDefineAwsCredentialHelpers()).toBe(true);
  });

  test("malformed settings.json → false, not a throw", () => {
    fs.writeFileSync(path.join(configDir, "settings.json"), "{not json");
    expect(claudeSettingsDefineAwsCredentialHelpers()).toBe(false);
  });

  test("helpers in the managed (enterprise) settings tier are found", () => {
    const managed = path.join(configDir, "managed-settings.json");
    fs.writeFileSync(managed, JSON.stringify({ awsAuthRefresh: "aws sso login" }));
    expect(
      claudeSettingsDefineAwsCredentialHelpers([path.join(configDir, "settings.json"), managed]),
    ).toBe(true);
  });
});

describe("detectInstanceMetadataCredentials endpoint resolution", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "AWS_EC2_METADATA_DISABLED",
    "AWS_EC2_METADATA_SERVICE_ENDPOINT",
    "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  ];

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  test("probes a configured AWS_EC2_METADATA_SERVICE_ENDPOINT instead of the IPv4 default", async () => {
    // Fake IMDS: answers the IMDSv2 token PUT and lists one role.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "PUT" && url.pathname === "/latest/api/token") {
          return new Response("test-token");
        }
        if (url.pathname === "/latest/meta-data/iam/security-credentials/") {
          return new Response("bedrock-instance-role");
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = `http://127.0.0.1:${server.port}/`;
      expect(await detectInstanceMetadataCredentials(2000)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("configured endpoint with no role listed → false", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "PUT" && url.pathname === "/latest/api/token") {
          return new Response("test-token");
        }
        return new Response("", { status: 404 });
      },
    });
    try {
      process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = `http://127.0.0.1:${server.port}`;
      expect(await detectInstanceMetadataCredentials(2000)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("AWS_EC2_METADATA_DISABLED wins over a configured endpoint", async () => {
    process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = "http://127.0.0.1:1";
    process.env.AWS_EC2_METADATA_DISABLED = "true";
    expect(await detectInstanceMetadataCredentials(200)).toBe(false);
  });
});

describe("ClaudeAgentSDKManager writeToLog timestamps", () => {
  let tempDir: string;
  let logger: Logger;
  let mockLogParser: ClaudeLogParser;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-sdk-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    mockLogParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "mock.log"),
      codonId: "test-codon",
      parsingInterval: 100,
    });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writeToLog adds ISO 8601 timestamp to messages", async () => {
    const logFilePath = path.join(tempDir, "test-timestamps.jsonl");
    const logStream = fs.createWriteStream(logFilePath);

    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);

    // Access private logStream and writeToLog via bracket notation
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).logStream = logStream;

    const message = { type: "assistant", message: { id: "msg_test", role: "assistant" } };
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(message);

    logStream.end();
    await new Promise<void>((resolve) => logStream.on("finish", resolve));

    const content = fs.readFileSync(logFilePath, "utf-8");
    const parsed = JSON.parse(content.trim());

    expect(parsed.timestamp).toBeDefined();
    expect(parsed.type).toBe("assistant");
    expect(parsed.message.id).toBe("msg_test");
    // Verify it's a valid ISO 8601 timestamp
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });

  test("writeToLog does not mutate the original message object", async () => {
    const logFilePath = path.join(tempDir, "test-no-mutation.jsonl");
    const logStream = fs.createWriteStream(logFilePath);

    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).logStream = logStream;

    const message: Record<string, unknown> = { type: "system", subtype: "init" };
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(message);

    // Original should not have timestamp added
    expect(message.timestamp).toBeUndefined();

    logStream.end();
    await new Promise<void>((resolve) => logStream.on("finish", resolve));
  });

  test("writeToLog writes multiple messages with distinct timestamps", async () => {
    const logFilePath = path.join(tempDir, "test-multi-timestamps.jsonl");
    const logStream = fs.createWriteStream(logFilePath);

    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).logStream = logStream;

    const msg1 = { type: "system", subtype: "init" };
    const msg2 = { type: "assistant", message: { id: "msg_1" } };
    const msg3 = { type: "result", subtype: "success" };

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(msg1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(msg2);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).writeToLog(msg3);

    logStream.end();
    await new Promise<void>((resolve) => logStream.on("finish", resolve));

    const lines = fs.readFileSync(logFilePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.timestamp).toBeDefined();
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    }
  });
});

describe("ClaudeAgentSDKManager idle timeout", () => {
  let tempDir: string;
  let logger: Logger;
  let mockLogParser: ClaudeLogParser;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-sdk-idle-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    logger = new Logger(path.join(tempDir, "test.log"));
    mockLogParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "mock.log"),
      codonId: "test-codon",
      parsingInterval: 100,
    });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("default is applied when neither codon nor runtime sets shimIdleTimeout", () => {
    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private field for unit test
    const defaultTimeout = (manager as any).defaultShimIdleTimeout;
    expect(defaultTimeout ?? DEFAULT_SDK_IDLE_TIMEOUT_SECONDS).toBe(
      DEFAULT_SDK_IDLE_TIMEOUT_SECONDS,
    );
    expect(DEFAULT_SDK_IDLE_TIMEOUT_SECONDS).toBe(180);
  });

  test("runtime default takes precedence over the built-in default", () => {
    const manager = new ClaudeAgentSDKManager(
      tempDir,
      tempDir,
      logger,
      mockLogParser,
      undefined,
      null,
      300,
    );
    // biome-ignore lint/suspicious/noExplicitAny: accessing private field for unit test
    expect((manager as any).defaultShimIdleTimeout).toBe(300);
  });

  test("writeSyntheticErrorResult writes a parseable, retriable error result", async () => {
    const logFilePath = path.join(tempDir, "synthetic-result.jsonl");
    const logStream = fs.createWriteStream(logFilePath);

    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    (manager as any).logStream = logStream;
    // biome-ignore lint/suspicious/noExplicitAny: accessing private field for unit test
    (manager as any).sessionId = "session-123";

    const timeoutError = new IdleTimeoutError(DEFAULT_SDK_IDLE_TIMEOUT_SECONDS * 1000);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    await (manager as any).writeSyntheticErrorResult(timeoutError.message);

    logStream.end();
    await new Promise<void>((resolve) => logStream.on("finish", resolve));

    const parsed = JSON.parse(fs.readFileSync(logFilePath, "utf-8").trim());
    expect(parsed.type).toBe("result");
    expect(parsed.subtype).toBe("error");
    expect(parsed.is_error).toBe(true);
    expect(parsed.session_id).toBe("session-123");
    expect(parsed.result).toContain("Idle timeout");

    // The runtime classifies this result text — it must come out retriable
    // so onFailure: "retry" fires after an idle-timeout abort.
    const reason = classifyApiErrorText(parsed.result);
    expect(reason).toMatchObject({ type: "timeout", retriable: true });
  });

  test("writeSyntheticErrorResult is a no-op without a log stream", async () => {
    const manager = new ClaudeAgentSDKManager(tempDir, tempDir, logger, mockLogParser);
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for unit test
    await expect((manager as any).writeSyntheticErrorResult("boom")).resolves.toBeUndefined();
  });
});
