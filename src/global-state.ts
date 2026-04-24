import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface GlobalStateShape {
  ["electron-persisted-atom-state"]?: Record<string, unknown>;
  ["thread-workspace-root-hints"]?: Record<string, string>;
  ["electron-saved-workspace-roots"]?: string[];
  ["project-order"]?: string[];
  ["active-workspace-roots"]?: string[];
  ["electron-workspace-root-labels"]?: Record<string, string>;
  ["projectless-thread-ids"]?: string[];
}

export class GlobalStateStore {
  private readonly statePath: string;

  public constructor(statePath = path.join(os.homedir(), ".codex", ".codex-global-state.json")) {
    this.statePath = statePath;
  }

  public ensureWorkspaceThreadMapping(threadId: string, workspaceRoot: string): void {
    const state = this.read();
    state["electron-saved-workspace-roots"] = uniqueStrings([
      ...(toStringArray(state["electron-saved-workspace-roots"]) || []),
      workspaceRoot,
    ]);

    state["project-order"] = uniqueStrings([
      workspaceRoot,
      ...(toStringArray(state["project-order"]) || []),
    ]);

    state["active-workspace-roots"] = uniqueStrings([
      workspaceRoot,
      ...(toStringArray(state["active-workspace-roots"]) || []),
    ]);

    const labels = asStringRecord(state["electron-workspace-root-labels"]);
    if (!labels[workspaceRoot]) {
      labels[workspaceRoot] = path.basename(workspaceRoot) || workspaceRoot;
    }
    state["electron-workspace-root-labels"] = labels;

    const hints = asStringRecord(state["thread-workspace-root-hints"]);
    hints[threadId] = workspaceRoot;
    state["thread-workspace-root-hints"] = hints;

    state["projectless-thread-ids"] = (toStringArray(state["projectless-thread-ids"]) || []).filter(
      (candidate) => candidate !== threadId,
    );

    this.write(state);
  }

  public listThreadWorkspaceRootHints(): Record<string, string> {
    return asStringRecord(this.read()["thread-workspace-root-hints"]);
  }

  private read(): GlobalStateShape {
    if (!fs.existsSync(this.statePath)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as GlobalStateShape;
  }

  private write(state: GlobalStateShape): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state), "utf8");
    fs.renameSync(tempPath, this.statePath);
  }
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter((item): item is string => typeof item === "string");
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }

  return result;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
