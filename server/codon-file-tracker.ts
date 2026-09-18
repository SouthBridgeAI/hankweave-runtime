import path from "node:path";
import type { FileNode, FileUpdatedSource } from "./schemas/event-schemas.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import type { ToolInputMap, ToolName } from "./types/tool-types.js";
import { type Logger, toError } from "./utils.js";
import type { WorkspaceFiles, WorkspaceSelection } from "./workspace/files.js";

export interface WatchedFileUpdate {
  path: string;
  filename: string;
  /**
   * The observed body. In-process only: the public `file.updated` event
   * carries its fingerprint (sha256/bytes), never the body itself — the
   * BodyResolver at the runtime chokepoint hashes this and retains it for
   * sentinel resolution (fingerprint-events proposal).
   */
  content: string;
  action: "created" | "modified" | "deleted";
  source: FileUpdatedSource;
}

export interface RecentFileAccess {
  path: string;
  timestamp: Date;
}

interface CodonFileTrackerEvents extends Record<string, unknown[]> {
  fileUpdated: [data: WatchedFileUpdate];
  fileTreeUpdated: [data: { tree: FileNode[] }];
  trackingError: [error: Error, context: string];
}

interface CodonFileTrackerConfig {
  files: WorkspaceFiles;
  checkpointedFiles?: readonly string[];
  logger: Logger;
}

// Mutating file tools only. Read is deliberately absent: a read changes
// nothing, so it must not journal a file.updated (Bug 3,
// intermediates/65-watched-patterns-bugs/03-read-bug-explainer.md).
const FILE_TOOLS = new Set<string>(["Write", "Edit", "MultiEdit"]);

/**
 * Per-codon watched-file state.
 *
 * The tracker deliberately emits protocol-neutral payloads. CodonRunner owns
 * its lifecycle, while HankweaveRuntime remains responsible for wrapping the
 * payloads in public server events and routing them to journals/sentinels.
 *
 * What the tracker knows that the workspace does not: which tools mutate
 * files, the shape of their inputs, and that an event describes the
 * ATTEMPTED call — so a path is judged as it would be once written (the
 * selection's `admit`), and a Write to a path with nothing there yet is the
 * `created` case.
 */
export class CodonFileTracker extends TypedEventEmitter<CodonFileTrackerEvents> {
  /** This codon's view of the workspace, scoped to its watched patterns. */
  private readonly watched: WorkspaceSelection;
  private readonly logger: Logger;
  private readonly pendingOperations = new Set<Promise<void>>();
  private recentFileAccess: RecentFileAccess | undefined;
  private initialized = false;
  private closed = false;

  constructor(config: CodonFileTrackerConfig) {
    super();
    this.watched = config.files.select(config.checkpointedFiles ?? []);
    this.logger = config.logger;
  }

  /** Emit the initial contents/tree for files already matched by this codon. */
  async initialize(): Promise<void> {
    if (this.initialized || this.closed) return;
    this.initialized = true;

    if (this.watched.patterns.length === 0) return;

    this.logger.log(`Watching patterns: ${this.watched.patterns.join(", ")}`);

    // An enumeration failure here (broken .gitignore, corrupt shadow index)
    // degrades to "no initial states" and is reported, never thrown: the
    // codon is already marked starting, and a runner that never launches
    // would block every later start as "already running".
    try {
      await this.emitInitialStates();
    } catch (error) {
      this.emit(
        "trackingError",
        toError(error),
        "initial watched-file enumeration (continuing without initial states)",
      );
    }
  }

  private async emitInitialStates(): Promise<void> {
    // Git-native listing over the shadow repo: gitignore respected with
    // git's own engine, paths POSIX-relative to the agent root. A file
    // vanishing between enumeration and read is skipped, not fatal.
    const files: Array<{ path: string; content: string; lastModified: Date }> = [];
    for (const filePath of await this.watched.files()) {
      const file = this.watched.read(filePath);
      if (file !== null) files.push({ path: filePath, ...file });
    }

    if (files.length === 0) return;

    for (const file of files) {
      this.emit("fileUpdated", {
        path: file.path,
        filename: path.basename(file.path),
        content: file.content,
        action: "created",
        source: { kind: "codon-start" },
      });
    }

    const mostRecent = files.reduce((latest, file) =>
      file.lastModified > latest.lastModified ? file : latest,
    );
    this.recentFileAccess = {
      path: mostRecent.path,
      timestamp: new Date(mostRecent.lastModified),
    };

    await this.emitFileTreeUpdate();
  }

  /**
   * Observe a tool use without blocking the synchronous parser callback.
   *
   * The underlying async method runs synchronously through fileUpdated and
   * only yields while rebuilding the tree. This preserves the current public
   * ordering where file.updated precedes assistant.action for a file tool.
   */
  observeToolUse(
    toolName: string,
    toolInput: Record<string, unknown> | undefined,
    toolUseId: string,
  ): void {
    if (this.closed || this.watched.patterns.length === 0 || !FILE_TOOLS.has(toolName)) return;

    const operation = this.handleFileToolCall(toolName as ToolName, toolInput, toolUseId).catch(
      (error) => {
        this.emit("trackingError", toError(error), `handleFileToolCall(${toolName})`);
      },
    );

    this.pendingOperations.add(operation);
    void operation.finally(() => {
      this.pendingOperations.delete(operation);
    });
  }

  getRecentFileAccess(): RecentFileAccess | undefined {
    if (!this.recentFileAccess) return undefined;
    return {
      ...this.recentFileAccess,
      timestamp: new Date(this.recentFileAccess.timestamp),
    };
  }

  /** Wait until every file-tree refresh already accepted by the tracker finishes. */
  async drain(): Promise<void> {
    while (this.pendingOperations.size > 0) {
      await Promise.all([...this.pendingOperations]);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.drain();
    this.removeAllListeners();
  }

  private async handleFileToolCall<T extends ToolName>(
    toolName: T,
    toolInput: Record<string, unknown> | undefined,
    toolUseId: string,
  ): Promise<void> {
    let rawPath: string | null = null;
    // null = the tool input does not carry the body (Edit/MultiEdit diffs, or
    // a malformed Write) — only then do we fall back to reading the disk.
    // Presence-based, not truthiness-based: a Write of "" is a real body and
    // must fingerprint as the empty string, never as the file's old contents.
    let content: string | null = null;

    // These are intentionally the existing tool-use-time semantics: events
    // still describe attempted tool calls, not confirmed results (the
    // attempt-vs-result gap remains a separate change, see Bug 3 doc).
    switch (toolName) {
      case "Write": {
        const input = toolInput as ToolInputMap["Write"] | undefined;
        rawPath = input?.file_path || null;
        content = typeof input?.content === "string" ? input.content : null;
        break;
      }
      case "Edit": {
        const input = toolInput as ToolInputMap["Edit"] | undefined;
        rawPath = input?.file_path || null;
        break;
      }
      case "MultiEdit": {
        const input = toolInput as ToolInputMap["MultiEdit"] | undefined;
        rawPath = input?.file_path || null;
        break;
      }
      default:
        return;
    }

    if (!rawPath) return;

    if (!this.initialized) {
      throw new Error("CodonFileTracker.observeToolUse called before initialize()");
    }

    // One question to the workspace, answered synchronously (the emit below
    // must precede the tool's own event): is this path — normalized, inside
    // the workspace, in the watched set, and not ignored or excluded — one
    // the file tree would show? An event streams iff it would. Fail-closed:
    // a verdict failure surfaces as a trackingError, and nothing is emitted.
    const filePath = this.watched.admit(rawPath);
    if (!filePath) return;

    // What is on disk BEFORE the tool runs: absent means a Write creates it.
    const existing = this.watched.read(filePath);
    const action: WatchedFileUpdate["action"] =
      toolName === "Write" && existing === null ? "created" : "modified";
    if (content === null) content = existing?.content ?? "";

    this.recentFileAccess = {
      path: filePath,
      timestamp: new Date(),
    };

    this.emit("fileUpdated", {
      path: filePath,
      filename: path.basename(filePath),
      content,
      action,
      source: { kind: "tool_use", toolUseId },
    });

    await this.emitFileTreeUpdate();
  }

  private async emitFileTreeUpdate(): Promise<void> {
    if (this.watched.patterns.length === 0) return;

    // ONE listing pass for every watched pattern (this runs on each file
    // tool call). Enumeration failures propagate to the caller (surfaced as
    // a trackingError), and no tree is published: clients keep the last
    // good tree instead of receiving an authoritative-looking empty one.
    const tree = await this.watched.tree();
    this.emit("fileTreeUpdated", { tree });
  }
}
