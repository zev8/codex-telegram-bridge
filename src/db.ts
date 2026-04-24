import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export interface ChatSession {
  readonly chatId: number;
  readonly threadId: string;
  readonly updatedAt: number;
}

export interface ThreadSelectedSkill {
  readonly threadId: string;
  readonly skillName: string;
  readonly skillPath: string;
  readonly updatedAt: number;
}

export type PendingRequestKind = "commandApproval" | "fileApproval" | "toolUserInput";

export interface PendingRequestRow {
  readonly token: string;
  readonly requestIdJson: string;
  readonly chatId: number;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly kind: PendingRequestKind;
  readonly telegramMessageId: number | null;
  readonly payloadJson: string;
  readonly createdAt: number;
}

export interface PendingRequestInput {
  readonly token: string;
  readonly requestIdJson: string;
  readonly chatId: number;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly kind: PendingRequestKind;
  readonly telegramMessageId?: number | null;
  readonly payloadJson: string;
}

export class BridgeDatabase {
  private readonly db: Database.Database;
  private readonly saveChatSessionTxn: (chatId: number, threadId: string, updatedAt: number) => void;

  public constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.saveChatSessionTxn = this.db.transaction((chatId: number, threadId: string, updatedAt: number) => {
      this.db
        .prepare<[string, number], void>("DELETE FROM chat_sessions WHERE thread_id = ? AND chat_id <> ?")
        .run(threadId, chatId);
      this.db
        .prepare<[number, string, number], void>(
          "INSERT INTO chat_sessions (chat_id, thread_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at",
        )
        .run(chatId, threadId, updatedAt);
    });
  }

  public close(): void {
    this.db.close();
  }

  public getUpdateOffset(): number | null {
    const row = this.db
      .prepare<[string], { value: string }>("SELECT value FROM app_state WHERE key = ?")
      .get("telegram_update_offset");
    return row ? Number.parseInt(row.value, 10) : null;
  }

  public setUpdateOffset(offset: number): void {
    this.db
      .prepare<[string, string], void>(
        "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run("telegram_update_offset", String(offset));
  }

  public listChatSessions(): ChatSession[] {
    return this.db
      .prepare<[], ChatSession>("SELECT chat_id as chatId, thread_id as threadId, updated_at as updatedAt FROM chat_sessions")
      .all();
  }

  public getChatSession(chatId: number): ChatSession | null {
    return (
      this.db
        .prepare<[number], ChatSession>(
          "SELECT chat_id as chatId, thread_id as threadId, updated_at as updatedAt FROM chat_sessions WHERE chat_id = ?",
        )
        .get(chatId) || null
    );
  }

  public saveChatSession(chatId: number, threadId: string): void {
    const updatedAt = Date.now();
    this.saveChatSessionTxn(chatId, threadId, updatedAt);
  }

  public findChatIdByThreadId(threadId: string): number | null {
    const row = this.db
      .prepare<[string], { chatId: number }>("SELECT chat_id as chatId FROM chat_sessions WHERE thread_id = ?")
      .get(threadId);
    return row?.chatId ?? null;
  }

  public listSelectedSkills(threadId: string): ThreadSelectedSkill[] {
    return this.db
      .prepare<[string], ThreadSelectedSkill>(
        "SELECT thread_id as threadId, skill_name as skillName, skill_path as skillPath, updated_at as updatedAt FROM thread_selected_skills WHERE thread_id = ? ORDER BY updated_at DESC, skill_name ASC",
      )
      .all(threadId);
  }

  public saveSelectedSkill(threadId: string, skillName: string, skillPath: string): void {
    const updatedAt = Date.now();
    this.db
      .prepare<[string, string, string, number], void>(
        "INSERT INTO thread_selected_skills (thread_id, skill_name, skill_path, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, skill_name) DO UPDATE SET skill_path = excluded.skill_path, updated_at = excluded.updated_at",
      )
      .run(threadId, skillName, skillPath, updatedAt);
  }

  public deleteSelectedSkill(threadId: string, skillName: string): void {
    this.db
      .prepare<[string, string], void>("DELETE FROM thread_selected_skills WHERE thread_id = ? AND skill_name = ?")
      .run(threadId, skillName);
  }

  public clearSelectedSkills(threadId: string): void {
    this.db.prepare<[string], void>("DELETE FROM thread_selected_skills WHERE thread_id = ?").run(threadId);
  }

  public clearPendingRequests(): void {
    this.db.prepare("DELETE FROM pending_requests").run();
  }

  public savePendingRequest(input: PendingRequestInput): void {
    const createdAt = Date.now();
    this.db
      .prepare<
        [string, string, number, string, string, string, PendingRequestKind, number | null, string, number],
        void
      >(
        "INSERT OR REPLACE INTO pending_requests (token, request_id_json, chat_id, thread_id, turn_id, item_id, kind, telegram_message_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.token,
        input.requestIdJson,
        input.chatId,
        input.threadId,
        input.turnId,
        input.itemId,
        input.kind,
        input.telegramMessageId ?? null,
        input.payloadJson,
        createdAt,
      );
  }

  public getPendingRequestByToken(token: string): PendingRequestRow | null {
    return (
      this.db
        .prepare<[string], PendingRequestRow>(
          "SELECT token, request_id_json as requestIdJson, chat_id as chatId, thread_id as threadId, turn_id as turnId, item_id as itemId, kind, telegram_message_id as telegramMessageId, payload_json as payloadJson, created_at as createdAt FROM pending_requests WHERE token = ?",
        )
        .get(token) || null
    );
  }

  public getLatestPendingRequestByChat(chatId: number, kind?: PendingRequestKind): PendingRequestRow | null {
    if (kind) {
      return (
        this.db
          .prepare<[number, PendingRequestKind], PendingRequestRow>(
            "SELECT token, request_id_json as requestIdJson, chat_id as chatId, thread_id as threadId, turn_id as turnId, item_id as itemId, kind, telegram_message_id as telegramMessageId, payload_json as payloadJson, created_at as createdAt FROM pending_requests WHERE chat_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(chatId, kind) || null
      );
    }

    return (
      this.db
        .prepare<[number], PendingRequestRow>(
          "SELECT token, request_id_json as requestIdJson, chat_id as chatId, thread_id as threadId, turn_id as turnId, item_id as itemId, kind, telegram_message_id as telegramMessageId, payload_json as payloadJson, created_at as createdAt FROM pending_requests WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(chatId) || null
    );
  }

  public deletePendingRequestByToken(token: string): void {
    this.db.prepare<[string], void>("DELETE FROM pending_requests WHERE token = ?").run(token);
  }

  public deletePendingRequestByRequestIdJson(requestIdJson: string): void {
    this.db.prepare<[string], void>("DELETE FROM pending_requests WHERE request_id_json = ?").run(requestIdJson);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        chat_id INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      DELETE FROM chat_sessions
      WHERE rowid IN (
        SELECT duplicate.rowid
        FROM chat_sessions AS duplicate
        JOIN chat_sessions AS kept
          ON duplicate.thread_id = kept.thread_id
         AND (
           duplicate.updated_at < kept.updated_at
           OR (duplicate.updated_at = kept.updated_at AND duplicate.rowid < kept.rowid)
         )
      );

      CREATE TABLE IF NOT EXISTS pending_requests (
        token TEXT PRIMARY KEY,
        request_id_json TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        telegram_message_id INTEGER,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_selected_skills (
        thread_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, skill_name)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_thread_id ON chat_sessions (thread_id);
      CREATE INDEX IF NOT EXISTS idx_thread_selected_skills_thread ON thread_selected_skills (thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pending_requests_chat ON pending_requests (chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pending_requests_request_id ON pending_requests (request_id_json);
    `);
  }
}
