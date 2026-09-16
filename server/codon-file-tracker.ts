import fs from "node:fs";
import path from "node:path";
import { fileResolver, type PathMatcher } from "./file-resolver.js";
import type { FileNode, FileUpdatedSource } from "./schemas/event-schemas.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import type { ToolInputMap, ToolName } from "./types/tool-types.js";
import { buildFileTree, type Logger, toError } from "./utils.js";

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
  agentRootPath: string;
  patterns: readonly string[];
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
 */
export class CodonFileTracker extends TypedEventEmitter<CodonFileTrackerEvents> {
  private readonly agentRootPath: string;
  private readonly patterns: string[];
  private readonly logger: Logger;
  private readonly pendingOperations = new Set<Promise<void>>();
  private pathMatcher: PathMatcher | undefined;
  private recentFileAccess: RecentFileAccess | undefined;
  private initialized = false;
  private closed = false;

  constructor(config: CodonFileTrackerConfig) {
    super();
    this.agentRootPath = config.agentRootPath;
    // Each runner receives its own authoritative copy, including an empty
    // array. A later codon can therefore never inherit an earlier codon's
    // patterns through shared runtime state.
    this.patterns = [...config.patterns];
    this.logger = config.logger;
  }

  /** Emit the initial contents/tree for files already matched by this codon. */
  async initialize(): Promise<void> {
    if (this.initialized || this.closed) return;
    this.initialized = true;

    if (this.patterns.length === 0) return;

    this.logger.log(`Watching patterns: ${this.patterns.join(", ")}`);

    // Built once here so the per-tool-use check stays synchronous. The same
    // resolver supplies the initial snapshot below, so both emission sites
    // share one set of glob and ignore semantics.
    this.pathMatcher = await fileResolver.createPathMatcher(this.agentRootPath, this.patterns);

    const resolvedFiles = await fileResolver.resolveFiles(this.agentRootPath, this.patterns);
    const files = await Promise.all(
      resolvedFiles.map(async (filePath) => {
        const fullPath = path.join(this.agentRootPath, filePath);
        const stats = await fs.promises.stat(fullPath);
        const content = await fs.promises.readFile(fullPath, "utf-8");
        return {
          path: filePath,
          content,
          lastModified: stats.mtime,
        };
      }),
    );

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
    if (this.closed || this.patterns.length === 0 || !FILE_TOOLS.has(toolName)) return;

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

    if (!this.pathMatcher) {
      throw new Error("CodonFileTracker.observeToolUse called before initialize()");
    }

    const filePath = this.pathMatcher.match(rawPath);
    if (!filePath) return;

    const fullPath = path.join(this.agentRootPath, filePath);
    let action: WatchedFileUpdate["action"] = "modified";
    if (toolName === "Write") {
      action = fs.existsSync(fullPath) ? "modified" : "created";
    }

    if (content === null) {
      content = "";
      if (fs.existsSync(fullPath)) {
        try {
          content = fs.readFileSync(fullPath, "utf-8");
        } catch (error) {
          this.logger.log(`Error reading file ${filePath}: ${toError(error).message}`, "error");
          return;
        }
      }
    }

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
    if (this.patterns.length === 0) return;

    const allTrees = await Promise.all(
      this.patterns.map((pattern) => buildFileTree(this.agentRootPath, pattern)),
    );
    this.emit("fileTreeUpdated", { tree: allTrees.flat() });
  }
}
