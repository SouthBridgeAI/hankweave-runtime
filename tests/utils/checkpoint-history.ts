import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HankweaveState } from "../../server/types/state-types.js";
import type { CheckpointHistory, CheckpointId } from "../../server/workspace/checkpoints.js";

/** Inspect the persisted run's checkpoint tree, independently of Git's HEAD/index. */
export function checkpointFiles(executionPath: string, agentRootPath: string): string {
  const state = JSON.parse(
    fs.readFileSync(path.join(executionPath, ".hankweave", "state.json"), "utf8"),
  ) as HankweaveState;
  const history = state.runs[0]?.gitBranch;
  if (!history) throw new Error("No checkpoint history for the latest run");
  return execFileSync("git", ["ls-tree", "-r", "--name-only", `refs/heads/${history}`, "--"], {
    cwd: agentRootPath,
    env: {
      ...process.env,
      GIT_DIR: path.join(executionPath, ".hankweave", "checkpoints", ".hankweavecheckpoints"),
      GIT_WORK_TREE: agentRootPath,
    },
    encoding: "utf8",
  });
}

/** Read a fixture history's explicit parent, failing if setup never created it. */
export async function requireHistoryTip(history: CheckpointHistory): Promise<CheckpointId> {
  const tip = await history.tip();
  if (tip === null) throw new Error(`Test history ${history.name} has no checkpoint`);
  return tip;
}
