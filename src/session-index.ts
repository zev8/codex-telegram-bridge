import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SessionIndexEntry {
  readonly id: string;
  readonly thread_name: string;
  readonly updated_at: string;
}

export class SessionIndexStore {
  private readonly indexPath: string;

  public constructor(indexPath = path.join(os.homedir(), ".codex", "session_index.jsonl")) {
    this.indexPath = indexPath;
  }

  public get(threadId: string): SessionIndexEntry | null {
    return this.readAll().find((entry) => entry.id === threadId) || null;
  }

  public readAll(): SessionIndexEntry[] {
    if (!fs.existsSync(this.indexPath)) {
      return [];
    }

    const raw = fs.readFileSync(this.indexPath, "utf8");
    const entries: SessionIndexEntry[] = [];

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as SessionIndexEntry;
        if (parsed.id && parsed.thread_name && parsed.updated_at) {
          entries.push(parsed);
        }
      } catch {
        continue;
      }
    }

    return entries;
  }

  public upsert(entry: SessionIndexEntry): void {
    const byId = new Map(this.readAll().map((item) => [item.id, item]));
    byId.set(entry.id, entry);

    const sorted = [...byId.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    const content = `${sorted.map((item) => JSON.stringify(item)).join("\n")}\n`;

    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });
    const tempPath = `${this.indexPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, this.indexPath);
  }
}
