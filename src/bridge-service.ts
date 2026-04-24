import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { RequestId } from "./generated/RequestId";
import type { ServerNotification } from "./generated/ServerNotification";
import type { ServerRequest } from "./generated/ServerRequest";
import type { CommandExecutionApprovalDecision } from "./generated/v2/CommandExecutionApprovalDecision";
import type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeApprovalDecision } from "./generated/v2/FileChangeApprovalDecision";
import type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams";
import type { SkillMetadata } from "./generated/v2/SkillMetadata";
import type { ThreadItem } from "./generated/v2/ThreadItem";
import type { ToolRequestUserInputParams } from "./generated/v2/ToolRequestUserInputParams";
import type { UserInput } from "./generated/v2/UserInput";
import { CodexAppServerClient } from "./codex-app-server";
import { getErrorMessage, isAuthRefreshError, isModelAccessError, selectCodexModel } from "./codex-model";
import type { AppConfig } from "./config";
import type { PendingRequestRow, ThreadSelectedSkill } from "./db";
import { BridgeDatabase } from "./db";
import { GlobalStateStore } from "./global-state";
import { ProgressMessage } from "./progress-message";
import { SessionIndexStore } from "./session-index";
import {
  TelegramClient,
  type TelegramCallbackQuery,
  type TelegramDocument,
  type TelegramInlineKeyboardButton,
  type TelegramMessage,
  type TelegramPhotoSize,
  type TelegramReplyMarkup,
  type TelegramUpdate,
  splitTelegramText,
} from "./telegram";

interface ChatRuntimeState {
  activeTurnId: string | null;
  activeTurnInput: UserInput[] | null;
  activeTurnModel: string | null;
  activeTurnRetryCount: number;
  currentThreadId: string | null;
  currentThreadName: string | null;
  pendingTurnStart: boolean;
  tracker: TurnTracker | null;
}

interface ToolPromptPayload {
  readonly questions: ToolRequestUserInputParams["questions"];
}

interface WorkspaceSessionChoice {
  readonly id: string;
  readonly threadName: string;
  readonly updatedAt: string;
}

interface AvailableSkillChoice {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly path: string;
  readonly scope: string;
  readonly available: boolean;
}

interface SkillPickerState {
  readonly threadId: string;
  readonly threadName: string;
  readonly skills: AvailableSkillChoice[];
  readonly selectedSkills: ThreadSelectedSkill[];
  readonly errorCount: number;
  readonly hasActiveTurn: boolean;
  readonly catalogError: string | null;
}

interface IncomingMessagePayload {
  readonly inputs: UserInput[];
  readonly namingText: string | null;
}

const SESSION_PAGE_SIZE = 8;
const SKILL_PAGE_SIZE = 6;
const MAX_TELEGRAM_IMAGE_BYTES = 20 * 1024 * 1024;
const TELEGRAM_FILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_FILE_CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const GENERATED_IMAGE_FRESH_WINDOW_MS = 10 * 60 * 1000;
const IMAGE_DOCUMENT_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".svgz",
  ".tif",
  ".tiff",
  ".webp",
]);
const ABSOLUTE_IMAGE_PATH_PATTERN = /\/[^\s"'<>|]+?\.(?:bmp|gif|heic|heif|jpe?g|png|svgz?|tiff?|webp)/gi;

class TurnTracker {
  private readonly progress: ProgressMessage;
  private readonly itemPhase = new Map<string, string | null>();
  private readonly itemText = new Map<string, string>();
  private commentary = "";
  private finalText = "";
  private finalSent = false;
  private statusLine: string | null = null;
  private errorLine: string | null = null;
  private mediaCount = 0;
  private readonly sentImagePaths = new Set<string>();

  public constructor(
    private readonly telegram: TelegramClient,
    private readonly chatId: number,
    private readonly replyToMessageId: number,
    progressIntervalMs: number,
  ) {
    this.progress = new ProgressMessage(telegram, chatId, progressIntervalMs, replyToMessageId);
  }

  public setStatusLine(line: string | null): void {
    this.statusLine = line;
    this.pushProgress();
  }

  public setErrorLine(line: string | null): void {
    this.errorLine = line;
    this.pushProgress();
  }

  public flushNow(): Promise<void> {
    return this.progress.flushNow();
  }

  public noteAgentItem(itemId: string, phase: string | null, text: string): void {
    this.itemPhase.set(itemId, phase);
    this.itemText.set(itemId, text);

    if (phase !== "final_answer") {
      this.commentary = text;
      this.pushProgress();
    }
  }

  public appendAgentDelta(itemId: string, delta: string): void {
    const nextText = `${this.itemText.get(itemId) || ""}${delta}`;
    this.itemText.set(itemId, nextText);

    if (this.itemPhase.get(itemId) !== "final_answer") {
      this.commentary = nextText;
      this.pushProgress();
    }
  }

  public async completeAgentItem(item: Extract<ThreadItem, { type: "agentMessage" }>): Promise<void> {
    this.itemPhase.set(item.id, item.phase);
    this.itemText.set(item.id, item.text);

    if (item.phase === "final_answer") {
      this.finalText = item.text.trim();
      await this.sendFinalIfNeeded();
      return;
    }

    this.commentary = item.text;
    this.pushProgress();
  }

  public async finish(status: string, errorMessage?: string | null): Promise<void> {
    if (errorMessage) {
      this.setErrorLine(`本轮失败：${errorMessage}`);
    }

    if (!this.finalSent) {
      if (this.finalText.trim()) {
        await this.sendFinalIfNeeded();
      } else if (status === "failed") {
        const fallback = this.errorLine || "Codex 未能完成这轮请求。";
        await this.renderTerminalText(fallback);
      } else if (this.mediaCount > 0) {
        await this.renderTerminalText(this.mediaCount === 1 ? "已发送 1 张图片。" : `已发送 ${this.mediaCount} 张图片。`);
        this.finalSent = true;
      } else if (this.commentary.trim()) {
        await this.renderTerminalText(this.commentary.trim());
        this.finalSent = true;
      }
    }

    if (!this.finalSent && status === "interrupted") {
      await this.renderTerminalText("当前回合已中断。");
      this.finalSent = true;
    }
  }

  public async sendImage(localPath: string): Promise<boolean> {
    const normalizedPath = path.resolve(localPath);
    if (this.sentImagePaths.has(normalizedPath)) {
      return false;
    }

    await this.progress.flushNow();
    await this.telegram.sendLocalImage(this.chatId, normalizedPath, {
      replyToMessageId: this.mediaCount === 0 ? this.replyToMessageId : undefined,
    });
    this.sentImagePaths.add(normalizedPath);
    this.mediaCount += 1;
    return true;
  }

  private async sendFinalIfNeeded(): Promise<void> {
    if (this.finalSent || !this.finalText.trim()) {
      return;
    }

    await this.renderTerminalText(this.finalText.trim());
    this.finalSent = true;
  }

  private async renderTerminalText(text: string): Promise<void> {
    const parts = splitTelegramText(text);

    await this.progress.flushNow();
    const progressMessageId = this.progress.getMessageId();

    if (progressMessageId === null) {
      await this.telegram.sendLongMessage(this.chatId, text, {
        replyToMessageId: this.replyToMessageId,
      });
      return;
    }

    await this.telegram.editMessageText(this.chatId, progressMessageId, parts[0] || text.trim());
    for (const part of parts.slice(1)) {
      await this.telegram.sendMessage(this.chatId, part);
    }
  }

  private pushProgress(): void {
    const chunks = ["Codex 正在处理..."];
    if (this.statusLine) {
      chunks.push(this.statusLine);
    }
    if (this.errorLine) {
      chunks.push(this.errorLine);
    }
    if (this.commentary.trim()) {
      chunks.push(this.commentary.trim());
    }

    this.progress.update(chunks.join("\n\n"));
  }
}

export class BridgeService {
  private readonly runtimeByChatId = new Map<number, ChatRuntimeState>();
  private readonly chatIdByThreadId = new Map<string, number>();
  private readonly loadedThreadIds = new Set<string>();
  private readonly sessionIndex = new SessionIndexStore();
  private readonly globalState = new GlobalStateStore();
  private readonly telegramFileDir: string;
  private stopRequested = false;
  private botUsername: string | null = null;
  private lastTelegramFileCleanupAt = 0;
  private activeCodexModel: string | null = null;
  private codexModelCandidates: readonly string[] = [];
  private readonly unavailableCodexModels = new Set<string>();
  private codexRestartPromise: Promise<void> | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly db: BridgeDatabase,
    private readonly telegram: TelegramClient,
    private readonly codex: CodexAppServerClient,
  ) {
    this.telegramFileDir = config.telegramFileDir;

    for (const session of db.listChatSessions()) {
      this.chatIdByThreadId.set(session.threadId, session.chatId);
      this.runtimeByChatId.set(session.chatId, {
        activeTurnId: null,
        activeTurnInput: null,
        activeTurnModel: null,
        activeTurnRetryCount: 0,
        currentThreadId: session.threadId,
        currentThreadName: null,
        pendingTurnStart: false,
        tracker: null,
      });
    }

    this.db.clearPendingRequests();
    this.codex.on("notification", (notification) => {
      void this.handleNotification(notification).catch((error) => {
        console.error("Failed to handle Codex notification:", error);
      });
    });
    this.codex.on("serverRequest", (request) => {
      void this.handleServerRequest(request).catch((error) => {
        console.error("Failed to handle Codex server request:", error);
      });
    });
  }

  public async start(): Promise<void> {
    await this.codex.start();
    await this.codex.ensureAuthenticated();
    await this.resolveActiveCodexModel();
    await this.reconcileDesktopSessionIndex();

    const bot = await this.telegram.getMe();
    this.botUsername = bot.username || null;
    await this.telegram.setMyCommands([
      { command: "start", description: "查看当前绑定状态" },
      { command: "new", description: "新建一个 Codex 对话" },
      { command: "current", description: "查看当前会话" },
      { command: "sessions", description: "选择已有会话" },
      { command: "skills", description: "选择当前会话技能" },
      { command: "model", description: "查看或切换 Codex 模型" },
    ]);

    console.log(`Connected Telegram bot @${bot.username || bot.first_name}`);
    console.log(`Whitelisted Telegram user: ${this.config.telegramAllowedUserId}`);

    const initialOffset = this.db.getUpdateOffset();
    let nextOffset = initialOffset;

    while (!this.stopRequested) {
      try {
        const updates = await this.telegram.getUpdates({
          offset: nextOffset ?? undefined,
          timeout: this.config.pollTimeoutSeconds,
          limit: this.config.pollLimit,
        });

        for (const update of updates) {
          try {
            await this.handleUpdate(update);
          } catch (error) {
            console.error(`Failed to handle Telegram update ${update.update_id}:`, error);
          } finally {
            nextOffset = update.update_id + 1;
            this.db.setUpdateOffset(nextOffset);
          }
        }
      } catch (error) {
        console.error("Polling loop error:", error);
        await sleep(2_000);
      }
    }
  }

  public stop(): void {
    this.stopRequested = true;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleIncomingMessage(update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  private async handleIncomingMessage(message: TelegramMessage): Promise<void> {
    const userId = message.from?.id;
    if (!userId || !isSupportedChatType(message.chat.type)) {
      return;
    }

    const isPrivateChat = message.chat.type === "private";
    if (userId !== this.config.telegramAllowedUserId) {
      if (isPrivateChat) {
        await this.telegram.sendMessage(message.chat.id, "This bot is private.");
      }
      return;
    }

    const text = getTelegramMessageText(message);

    const command = parseBotCommand(text, this.botUsername);
    if (command && !command.addressedToCurrentBot) {
      return;
    }
    if (command && isSupportedCommand(command.command)) {
      await this.handleCommand(command.command, message);
      return;
    }

    const pendingUserInput = this.db.getLatestPendingRequestByChat(message.chat.id, "toolUserInput");
    if (pendingUserInput && text && !hasTelegramImage(message)) {
      const handled = await this.tryResolveToolUserInputFromText(pendingUserInput, text, message.message_id);
      if (handled) {
        return;
      }
    }

    let payload: IncomingMessagePayload | null;
    try {
      payload = await this.buildIncomingMessagePayload(message);
    } catch (error) {
      await this.telegram.sendMessage(
        message.chat.id,
        error instanceof Error ? error.message : "图片处理失败，请稍后重试。",
        { replyToMessageId: message.message_id },
      );
      return;
    }

    if (!payload) {
      await this.telegram.sendMessage(message.chat.id, "目前只支持纯文本和图片消息。", {
        replyToMessageId: message.message_id,
      });
      return;
    }

    const runtime = this.getOrCreateRuntime(message.chat.id);
    let threadId = runtime.currentThreadId;
    if (!threadId) {
      if (!isPrivateChat) {
        await this.telegram.sendMessage(
          message.chat.id,
          "这个聊天还没有绑定会话。发送 /sessions 选择已有会话，或发送 /new 新建一个。",
          { replyToMessageId: message.message_id },
        );
        return;
      }

      threadId = await this.createNewThread(message.chat.id, false);
    }

    if (payload.namingText) {
      await this.ensureThreadNamedForDesktop(runtime, threadId, payload.namingText);
    }
    await this.touchDesktopSessionIndex(threadId, runtime.currentThreadName);
    const turnInput = await this.buildTurnInputs(threadId, payload.inputs);

    if (runtime.pendingTurnStart) {
      await this.telegram.sendMessage(message.chat.id, "上一轮正在启动，请稍等几秒再发下一条。", {
        replyToMessageId: message.message_id,
      });
      return;
    }

    if (runtime.activeTurnId) {
      try {
        await this.codex.steerTurn({
          threadId,
          input: turnInput,
          expectedTurnId: runtime.activeTurnId,
        });
        await this.telegram.sendMessage(message.chat.id, "我已经把这条消息追加到当前回合里了。", {
          replyToMessageId: message.message_id,
        });
      } catch (error) {
        console.error(`Failed to steer active turn ${runtime.activeTurnId} for thread ${threadId}:`, error);
        this.clearActiveTurn(runtime);
        await this.sendTelegramFailureNotice(
          message.chat.id,
          "追加到当前回合失败了，请再发一次消息重试。",
          message.message_id,
        );
      }
      return;
    }

    await this.ensureThreadLoaded(threadId);
    await this.telegram.sendChatAction(message.chat.id, "typing");

    const tracker = new TurnTracker(
      this.telegram,
      message.chat.id,
      message.message_id,
      this.config.progressUpdateIntervalMs,
    );
    runtime.tracker = tracker;
    runtime.pendingTurnStart = true;
    runtime.activeTurnInput = turnInput;
    runtime.activeTurnModel = this.activeCodexModel;
    runtime.activeTurnRetryCount = 0;
    tracker.setStatusLine("正在把消息交给 Codex...");
    await tracker.flushNow();

    try {
      await this.startRuntimeTurn(runtime, threadId, turnInput, tracker, 0);
    } catch (error) {
      console.error(`Failed to start turn for thread ${threadId}:`, error);
      if (await this.retryTurnAfterAuthRefresh(runtime, threadId, tracker, getErrorMessage(error))) {
        return;
      }
      if (await this.retryTurnWithFallback(runtime, threadId, tracker, getErrorMessage(error))) {
        return;
      }
      this.clearActiveTurn(runtime);
      await tracker.finish("failed", "启动这一轮对话失败了，请稍后重试。");
    }
  }

  private async handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
    if (callbackQuery.from.id !== this.config.telegramAllowedUserId) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "Unauthorized");
      return;
    }

    const data = callbackQuery.data;
    if (!data) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "Empty callback");
      return;
    }

    if (data.startsWith("ap:")) {
      const [, token = "", decision = ""] = data.split(":", 3);
      if (!token || !decision) {
        await this.telegram.answerCallbackQuery(callbackQuery.id, "Invalid action");
        return;
      }

      const pending = this.db.getPendingRequestByToken(token);
      if (!pending) {
        await this.telegram.answerCallbackQuery(callbackQuery.id, "这个请求已经处理过了。");
        return;
      }

      await this.handleApprovalDecision(pending, decision, callbackQuery);
      return;
    }

    if (data.startsWith("iu:")) {
      const [, token = "", decision = ""] = data.split(":", 3);
      if (!token || !decision) {
        await this.telegram.answerCallbackQuery(callbackQuery.id, "Invalid action");
        return;
      }

      const pending = this.db.getPendingRequestByToken(token);
      if (!pending) {
        await this.telegram.answerCallbackQuery(callbackQuery.id, "这个请求已经处理过了。");
        return;
      }

      await this.handleToolUserInputDecision(pending, decision, callbackQuery);
      return;
    }

    if (data.startsWith("sp:")) {
      await this.handleSessionPickerPage(callbackQuery, data.slice(3));
      return;
    }

    if (data.startsWith("sb:")) {
      await this.handleSessionBinding(callbackQuery, data.slice(3));
      return;
    }

    if (data.startsWith("kg:")) {
      await this.handleSkillPickerPage(callbackQuery, data.slice(3));
      return;
    }

    if (data.startsWith("kt:")) {
      await this.handleSkillToggle(callbackQuery, data.slice(3));
      return;
    }

    if (data.startsWith("kc:")) {
      await this.handleSkillClear(callbackQuery, data.slice(3));
      return;
    }

    if (data.startsWith("mp:")) {
      await this.handleModelPickerRefresh(callbackQuery);
      return;
    }

    if (data.startsWith("ma:")) {
      await this.handleModelAutoSelect(callbackQuery);
      return;
    }

    if (data.startsWith("ms:")) {
      await this.handleModelSelect(callbackQuery, data.slice(3));
      return;
    }

    await this.telegram.answerCallbackQuery(callbackQuery.id, "Unsupported action");
  }

  private async handleCommand(command: string, message: TelegramMessage): Promise<void> {
    switch (command) {
      case "start":
        await this.handleStartCommand(message);
        return;
      case "new":
        await this.handleNewCommand(message);
        return;
      case "current":
        await this.handleCurrentCommand(message);
        return;
      case "sessions":
        await this.showWorkspaceSessions(message.chat.id, message.message_id, 0);
        return;
      case "skills":
        await this.handleSkillsCommand(message);
        return;
      case "model":
        await this.handleModelCommand(message);
        return;
      default:
        return;
    }
  }

  private async handleStartCommand(message: TelegramMessage): Promise<void> {
    const current = await this.getCurrentThreadSummary(message.chat.id);
    if (current) {
      const skillsSummary = this.renderSelectedSkillsSummary(current.id);
      await this.telegram.sendMessage(
        message.chat.id,
        `Codex 已连接。\n\n当前会话：${current.name}\n线程：${current.id}\n${this.renderModelSummary()}\n${skillsSummary}\n\n发送 /sessions 可以切换已有会话，发送 /skills 可以选择技能，发送 /new 可以新建一个。`,
        { replyToMessageId: message.message_id },
      );
      return;
    }

    if (message.chat.type === "private") {
      const threadId = await this.createNewThread(message.chat.id, false);
      const name = (await this.getCurrentThreadSummary(message.chat.id))?.name || threadId;
      await this.telegram.sendMessage(
        message.chat.id,
        `Codex 已连接。\n\n已新建会话：${name}\n线程：${threadId}\n${this.renderModelSummary()}\n当前技能：未选择\n\n直接发消息即可，发送 /sessions 可以切换已有会话，发送 /skills 可以选择技能。`,
        { replyToMessageId: message.message_id },
      );
      return;
    }

    await this.telegram.sendMessage(
      message.chat.id,
      "Codex 已连接。\n\n这个聊天还没有绑定会话。发送 /sessions 选择已有会话，或发送 /new 新建一个。",
      { replyToMessageId: message.message_id },
    );
  }

  private async handleNewCommand(message: TelegramMessage): Promise<void> {
    const threadId = await this.createNewThread(message.chat.id, true);
    const current = await this.getCurrentThreadSummary(message.chat.id);
    await this.telegram.sendMessage(
      message.chat.id,
      `已新建一个 Codex 对话。\n\n当前会话：${current?.name || threadId}\n线程：${threadId}\n${this.renderModelSummary()}\n当前技能：未选择`,
      { replyToMessageId: message.message_id },
    );
  }

  private async handleCurrentCommand(message: TelegramMessage): Promise<void> {
    const current = await this.getCurrentThreadSummary(message.chat.id);
    if (!current) {
      await this.telegram.sendMessage(
        message.chat.id,
        message.chat.type === "private"
          ? "当前还没有会话。发送 /new 新建一个，或发送 /sessions 选择已有会话。"
          : "这个聊天还没有绑定会话。发送 /sessions 选择已有会话，或发送 /new 新建一个。",
        { replyToMessageId: message.message_id },
      );
      return;
    }

    await this.telegram.sendMessage(
      message.chat.id,
      `当前会话：${current.name}\n线程：${current.id}\n${this.renderModelSummary()}\n${this.renderSelectedSkillsSummary(current.id)}`,
      { replyToMessageId: message.message_id },
    );
  }

  private async handleSkillsCommand(message: TelegramMessage): Promise<void> {
    const threadId = await this.ensureThreadForSkills(message);
    if (!threadId) {
      return;
    }

    await this.showThreadSkills(message.chat.id, message.message_id, threadId, 0);
  }

  private async handleModelCommand(message: TelegramMessage): Promise<void> {
    const view = this.buildModelPickerView(message.chat.id);
    await this.telegram.sendMessage(message.chat.id, view.text, {
      replyToMessageId: message.message_id,
      replyMarkup: view.replyMarkup,
    });
  }

  private async handleApprovalDecision(
    pending: PendingRequestRow,
    rawDecision: string,
    callbackQuery: TelegramCallbackQuery,
  ): Promise<void> {
    const decision = rawDecision as CommandExecutionApprovalDecision | FileChangeApprovalDecision;
    await this.codex.respond(JSON.parse(pending.requestIdJson) as RequestId, { decision });

    if (pending.telegramMessageId !== null) {
      await this.telegram.editMessageText(
        pending.chatId,
        pending.telegramMessageId,
        `${renderPendingRequestText(pending)}\n\n已提交：${renderDecisionLabel(rawDecision)}`,
      );
    }

    this.db.deletePendingRequestByToken(pending.token);
    await this.telegram.answerCallbackQuery(callbackQuery.id, "已提交给 Codex");
  }

  private async handleToolUserInputDecision(
    pending: PendingRequestRow,
    rawDecision: string,
    callbackQuery: TelegramCallbackQuery,
  ): Promise<void> {
    const payload = JSON.parse(pending.payloadJson) as ToolPromptPayload;
    const [question] = payload.questions;
    if (!question || !question.options || !question.options[Number.parseInt(rawDecision, 10)]) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效选项");
      return;
    }

    const selected = question.options[Number.parseInt(rawDecision, 10)];
    if (!selected) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效选项");
      return;
    }
    await this.codex.respond(JSON.parse(pending.requestIdJson) as RequestId, {
      answers: {
        [question.id]: {
          answers: [selected.label],
        },
      },
    });

    if (pending.telegramMessageId !== null) {
      await this.telegram.editMessageText(
        pending.chatId,
        pending.telegramMessageId,
        `${renderPendingRequestText(pending)}\n\n已回答：${selected.label}`,
      );
    }

    this.db.deletePendingRequestByToken(pending.token);
    await this.telegram.answerCallbackQuery(callbackQuery.id, "已提交");
  }

  private async tryResolveToolUserInputFromText(
    pending: PendingRequestRow,
    text: string,
    messageId: number,
  ): Promise<boolean> {
    const payload = JSON.parse(pending.payloadJson) as ToolPromptPayload;
    const requestId = JSON.parse(pending.requestIdJson) as RequestId;

    if (payload.questions.some((question) => question.isSecret)) {
      await this.telegram.sendMessage(
        pending.chatId,
        "这个输入请求包含隐藏答案，Telegram 端不安全，请改回桌面端处理。",
        { replyToMessageId: messageId },
      );
      return true;
    }

    let answers: Record<string, { answers: string[] }> | null = null;

    if (payload.questions.length === 1) {
      const [question] = payload.questions;
      if (!question) {
        return false;
      }
      answers = {
        [question.id]: {
          answers: [text],
        },
      };
    } else {
      answers = parseStructuredAnswers(payload.questions, text);
      if (!answers) {
        await this.telegram.sendMessage(
          pending.chatId,
          "这个输入请求需要多项回答。请按 `问题ID: 回答` 的格式逐行回复。",
          { replyToMessageId: messageId },
        );
        return true;
      }
    }

    await this.codex.respond(requestId, { answers });
    this.db.deletePendingRequestByToken(pending.token);
    await this.telegram.sendMessage(pending.chatId, "已把你的回答提交给 Codex。", {
      replyToMessageId: messageId,
    });
    return true;
  }

  private async handleNotification(notification: ServerNotification): Promise<void> {
    switch (notification.method) {
      case "thread/started":
        this.loadedThreadIds.add(notification.params.thread.id);
        return;
      case "thread/name/updated": {
        const chatId = this.chatIdByThreadId.get(notification.params.threadId);
        if (chatId) {
          const runtime = this.getOrCreateRuntime(chatId);
          if (runtime.currentThreadId === notification.params.threadId) {
            runtime.currentThreadName = notification.params.threadName || null;
          }
        }
        if (notification.params.threadName) {
          await this.touchDesktopSessionIndex(notification.params.threadId, notification.params.threadName);
        }
        return;
      }
      case "thread/closed":
        this.loadedThreadIds.delete(notification.params.threadId);
        return;
      case "thread/status/changed":
        if (notification.params.status.type === "notLoaded") {
          this.loadedThreadIds.delete(notification.params.threadId);
        }
        return;
      case "item/started":
        await this.handleItemStarted(notification.params.threadId, notification.params.turnId, notification.params.item);
        return;
      case "item/completed":
        await this.handleItemCompleted(notification.params.threadId, notification.params.turnId, notification.params.item);
        return;
      case "item/agentMessage/delta": {
        const tracker = this.findTracker(notification.params.threadId, notification.params.turnId);
        tracker?.appendAgentDelta(notification.params.itemId, notification.params.delta);
        return;
      }
      case "error": {
        const tracker = this.findTracker(notification.params.threadId, notification.params.turnId);
        tracker?.setErrorLine(this.renderTurnErrorMessage(notification.params.error.message) || notification.params.error.message);
        return;
      }
      case "turn/completed":
        await this.handleTurnCompleted(
          notification.params.threadId,
          notification.params.turn.id,
          notification.params.turn.status,
          this.renderTurnErrorMessage(notification.params.turn.error?.message || null),
        );
        return;
      case "serverRequest/resolved":
        this.db.deletePendingRequestByRequestIdJson(JSON.stringify(notification.params.requestId));
        return;
      default:
        return;
    }
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        await this.sendApprovalRequest("commandApproval", request.id, request.params.threadId, request.params.turnId, request.params.itemId, request.params);
        return;
      case "item/fileChange/requestApproval":
        await this.sendApprovalRequest("fileApproval", request.id, request.params.threadId, request.params.turnId, request.params.itemId, request.params);
        return;
      case "item/tool/requestUserInput":
        await this.sendToolUserInputRequest(request.id, request.params);
        return;
      default: {
        const threadId =
          "params" in request && request.params && typeof request.params === "object" && "threadId" in request.params
            ? String((request.params as { threadId: string }).threadId)
            : null;
        const chatId = threadId ? this.chatIdByThreadId.get(threadId) : undefined;
        if (chatId) {
          await this.telegram.sendMessage(
            chatId,
            `Codex 发来了一个 Telegram 端暂不支持的交互：${request.method}。\n请回到桌面端继续。`,
          );
        }
        await this.codex.respondError(request.id, `Unsupported server request for Telegram bridge: ${request.method}`);
      }
    }
  }

  private async handleItemStarted(threadId: string, turnId: string, item: ThreadItem): Promise<void> {
    const tracker = this.findTracker(threadId, turnId);
    if (!tracker) {
      return;
    }

    switch (item.type) {
      case "agentMessage":
        tracker.noteAgentItem(item.id, item.phase, item.text);
        return;
      case "imageGeneration":
        tracker.setStatusLine("正在生成图片");
        return;
      case "imageView":
        tracker.setStatusLine("正在准备图片");
        return;
      case "commandExecution":
        tracker.setStatusLine(`运行命令：${item.command}`);
        return;
      case "fileChange":
        tracker.setStatusLine(`准备修改 ${item.changes.length} 个文件`);
        return;
      case "enteredReviewMode":
        tracker.setStatusLine("进入 Review 模式");
        return;
      default:
        return;
    }
  }

  private async handleItemCompleted(threadId: string, turnId: string, item: ThreadItem): Promise<void> {
    const tracker = this.findTracker(threadId, turnId);
    if (!tracker) {
      return;
    }

    switch (item.type) {
      case "agentMessage":
        await tracker.completeAgentItem(item);
        return;
      case "imageView":
        await this.sendTrackerImage(tracker, item.path, "查看图片");
        return;
      case "imageGeneration":
        if (item.savedPath) {
          await this.sendTrackerImage(tracker, item.savedPath, "生成图片");
          return;
        }
        tracker.setStatusLine(`图片生成状态：${item.status}`);
        if (item.status === "completed") {
          tracker.setErrorLine("图片已生成，但没有可发送的本地文件。");
        }
        return;
      case "commandExecution":
        await this.sendCommandExecutionImages(tracker, item);
        tracker.setStatusLine(
          item.exitCode === null ? "命令已结束" : `命令已结束，退出码 ${item.exitCode}`,
        );
        return;
      case "fileChange":
        tracker.setStatusLine(
          item.status === "completed" ? "文件修改已应用" : `文件修改状态：${item.status}`,
        );
        return;
      default:
        return;
    }
  }

  private async handleTurnCompleted(
    threadId: string,
    turnId: string,
    status: string,
    errorMessage: string | null,
  ): Promise<void> {
    const chatId = this.chatIdByThreadId.get(threadId);
    if (!chatId) {
      return;
    }

    const runtime = this.getOrCreateRuntime(chatId);
    const tracker = this.findTracker(threadId, turnId);
    try {
      if (
        status === "failed" &&
        isAuthRefreshError(errorMessage) &&
        tracker &&
        runtime.activeTurnInput &&
        runtime.activeTurnRetryCount < 1
      ) {
        const retried = await this.retryTurnAfterAuthRefresh(runtime, threadId, tracker, errorMessage || "");
        if (retried) {
          return;
        }
      }

      if (
        status === "failed" &&
        isModelAccessError(errorMessage) &&
        tracker &&
        runtime.activeTurnInput &&
        runtime.activeTurnRetryCount < 1
      ) {
        const retried = await this.retryTurnWithFallback(runtime, threadId, tracker, errorMessage || "");
        if (retried) {
          return;
        }
      }

      if (tracker) {
        await tracker.finish(status, errorMessage);
      }
    } finally {
      if (runtime.currentThreadId === threadId && runtime.activeTurnId === turnId) {
        this.clearActiveTurn(runtime);
      }
    }
  }

  private async sendTrackerImage(tracker: TurnTracker, imagePath: string, source: string): Promise<void> {
    try {
      const sent = await tracker.sendImage(imagePath);
      if (sent) {
        tracker.setStatusLine("图片已发送到 Telegram");
      }
    } catch (error) {
      console.warn(`Failed to send ${source} back to Telegram from ${imagePath}:`, error);
      tracker.setErrorLine(`无法回传${source}，请回到桌面端查看。`);
    }
  }

  private async sendCommandExecutionImages(
    tracker: TurnTracker,
    item: Extract<ThreadItem, { type: "commandExecution" }>,
  ): Promise<void> {
    if (item.status !== "completed") {
      return;
    }

    const imagePaths = await collectGeneratedImagePathsFromCommandExecution(item);
    for (const imagePath of imagePaths) {
      await this.sendTrackerImage(tracker, imagePath, "命令输出图片");
    }
  }

  private async sendTelegramFailureNotice(chatId: number, text: string, replyToMessageId?: number): Promise<void> {
    try {
      await this.telegram.sendMessage(chatId, text, { replyToMessageId });
    } catch (error) {
      console.error(`Failed to send Telegram failure notice to chat ${chatId}:`, error);
    }
  }

  private async sendApprovalRequest(
    kind: "commandApproval" | "fileApproval",
    requestId: RequestId,
    threadId: string,
    turnId: string,
    itemId: string,
    params: CommandExecutionRequestApprovalParams | FileChangeRequestApprovalParams,
  ): Promise<void> {
    const chatId = this.chatIdByThreadId.get(threadId) ?? this.db.findChatIdByThreadId(threadId);
    if (!chatId) {
      await this.codex.respondError(requestId, "No Telegram chat is bound to this Codex thread");
      return;
    }

    const token = createShortToken();
    const markup = buildApprovalKeyboard(token, kind, params);
    const text = renderApprovalPrompt(kind, params);
    const message = await this.telegram.sendMessage(chatId, text, { replyMarkup: markup });

    this.db.savePendingRequest({
      token,
      requestIdJson: JSON.stringify(requestId),
      chatId,
      threadId,
      turnId,
      itemId,
      kind,
      telegramMessageId: message.message_id,
      payloadJson: JSON.stringify(params),
    });
  }

  private async sendToolUserInputRequest(requestId: RequestId, params: ToolRequestUserInputParams): Promise<void> {
    const chatId = this.chatIdByThreadId.get(params.threadId) ?? this.db.findChatIdByThreadId(params.threadId);
    if (!chatId) {
      await this.codex.respondError(requestId, "No Telegram chat is bound to this Codex thread");
      return;
    }

    const token = createShortToken();
    const [firstQuestion] = params.questions;
    const replyMarkup =
      params.questions.length === 1 && firstQuestion?.options?.length
        ? buildToolUserInputKeyboard(token, firstQuestion.options)
        : undefined;

    const text = renderToolUserInputPrompt(params.questions);
    const message = await this.telegram.sendMessage(chatId, text, { replyMarkup });

    this.db.savePendingRequest({
      token,
      requestIdJson: JSON.stringify(requestId),
      chatId,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      kind: "toolUserInput",
      telegramMessageId: message.message_id,
      payloadJson: JSON.stringify({ questions: params.questions } satisfies ToolPromptPayload),
    });
  }

  private async resolveActiveCodexModel(): Promise<void> {
    const selection = await selectCodexModel(this.codex, this.config, this.unavailableCodexModels);
    this.activeCodexModel = selection.model;
    this.codexModelCandidates = selection.candidates;

    console.log(`Codex models OK: ${selection.visibleModelCount} model(s) visible`);
    if (selection.failures.length > 0) {
      for (const failure of selection.failures) {
        console.warn(`Codex model probe failed for ${failure.model}: ${failure.error}`);
      }
    }
    console.log(`Codex active model: ${selection.model}`);
  }

  private async startRuntimeTurn(
    runtime: ChatRuntimeState,
    threadId: string,
    input: UserInput[],
    tracker: TurnTracker,
    retryCount: number,
  ): Promise<void> {
    const model = this.requireActiveCodexModel();
    const response = await this.codex.startTurn({
      threadId,
      input,
      model,
    });

    if (runtime.activeTurnId && runtime.activeTurnId !== response.turn.id) {
      console.warn(
        `Turn tracker attached to ${runtime.activeTurnId} before startTurn returned ${response.turn.id} for thread ${threadId}`,
      );
    }

    runtime.activeTurnId = response.turn.id;
    runtime.activeTurnInput = input;
    runtime.activeTurnModel = model;
    runtime.activeTurnRetryCount = retryCount;
    runtime.pendingTurnStart = false;
    runtime.tracker = tracker;
  }

  private async retryTurnWithFallback(
    runtime: ChatRuntimeState,
    threadId: string,
    tracker: TurnTracker,
    reason: string,
  ): Promise<boolean> {
    if (!isModelAccessError(reason) || !runtime.activeTurnInput || runtime.activeTurnRetryCount >= 1) {
      return false;
    }

    const failedModel = runtime.activeTurnModel || this.activeCodexModel;
    if (failedModel) {
      this.unavailableCodexModels.add(failedModel);
    }

    try {
      await this.resolveActiveCodexModel();
    } catch (error) {
      console.error("Failed to select fallback Codex model:", error);
      return false;
    }

    const nextModel = this.requireActiveCodexModel();
    if (failedModel && nextModel === failedModel) {
      return false;
    }

    tracker.setStatusLine(`模型 ${failedModel || "unknown"} 不可用，已切换到 ${nextModel}，正在重试本轮...`);
    runtime.pendingTurnStart = true;

    try {
      await this.startRuntimeTurn(runtime, threadId, runtime.activeTurnInput, tracker, runtime.activeTurnRetryCount + 1);
      return true;
    } catch (error) {
      console.error(`Failed to retry turn with fallback model ${nextModel}:`, error);
      if (isModelAccessError(getErrorMessage(error))) {
        this.unavailableCodexModels.add(nextModel);
      }
      return false;
    }
  }

  private async retryTurnAfterAuthRefresh(
    runtime: ChatRuntimeState,
    threadId: string,
    tracker: TurnTracker,
    reason: string,
  ): Promise<boolean> {
    if (!isAuthRefreshError(reason) || !runtime.activeTurnInput || runtime.activeTurnRetryCount >= 1) {
      return false;
    }

    tracker.setStatusLine("Codex 登录账号已变化，正在重启本地 app-server 并重试本轮...");
    runtime.pendingTurnStart = true;
    runtime.activeTurnId = null;

    try {
      await this.restartCodexAppServer();
      await this.ensureThreadLoaded(threadId);
      await this.startRuntimeTurn(runtime, threadId, runtime.activeTurnInput, tracker, runtime.activeTurnRetryCount + 1);
      return true;
    } catch (error) {
      console.error("Failed to recover Codex auth and retry turn:", error);
      tracker.setErrorLine(this.renderTurnErrorMessage(getErrorMessage(error)) || getErrorMessage(error));
      return false;
    }
  }

  private async restartCodexAppServer(): Promise<void> {
    if (this.codexRestartPromise) {
      await this.codexRestartPromise;
      return;
    }

    this.codexRestartPromise = (async () => {
      console.warn("Restarting Codex app-server after authentication state changed");
      await this.codex.close();
      this.loadedThreadIds.clear();
      this.activeCodexModel = null;
      this.unavailableCodexModels.clear();
      await this.codex.start();
      await this.codex.ensureAuthenticated();
      await this.resolveActiveCodexModel();
    })();

    try {
      await this.codexRestartPromise;
    } finally {
      this.codexRestartPromise = null;
    }
  }

  private requireActiveCodexModel(): string {
    if (!this.activeCodexModel) {
      throw new Error("Codex model has not been selected yet");
    }

    return this.activeCodexModel;
  }

  private async createNewThread(chatId: number, interruptCurrent: boolean): Promise<string> {
    const response = await this.codex.startThread({
      cwd: this.config.codexWorkspaceCwd,
      serviceName: this.config.serviceName,
      model: this.requireActiveCodexModel(),
    });

    const defaultName = buildDefaultThreadName();
    try {
      await this.codex.setThreadName(response.thread.id, defaultName);
    } catch (error) {
      console.warn(`Failed to set initial name for thread ${response.thread.id}:`, error);
    }

    await this.bindThreadToChat(chatId, response.thread.id, defaultName, { interruptCurrent });
    this.loadedThreadIds.add(response.thread.id);
    return response.thread.id;
  }

  private async ensureThreadLoaded(threadId: string): Promise<void> {
    if (this.loadedThreadIds.has(threadId)) {
      return;
    }

    await this.codex.resumeThread({
      threadId,
      model: this.requireActiveCodexModel(),
    });
    this.loadedThreadIds.add(threadId);
  }

  private renderTurnErrorMessage(errorMessage: string | null): string | null {
    if (!errorMessage) {
      return null;
    }

    if (isAuthRefreshError(errorMessage)) {
      return `${errorMessage}\n\n桥接检测到 Codex 登录账号发生变化。如果你已经在 Codex 里重新登录，桥接会自动重启本地 app-server 并重试一次；如果仍失败，请在 Codex 桌面端或 CLI 重新登录后再发一次。`;
    }

    if (/model .*does not exist or you do not have access/i.test(errorMessage)) {
      const configuredModel = this.activeCodexModel || this.config.codexModel || "自动选择模型";
      return `${errorMessage}\n\n桥接当前使用的模型不可用：${configuredModel}。请在桥接配置里调整 CODEX_MODEL_CANDIDATES 或 CODEX_MODEL_FALLBACKS。`;
    }

    return errorMessage;
  }

  private getOrCreateRuntime(chatId: number): ChatRuntimeState {
    let runtime = this.runtimeByChatId.get(chatId);
    if (!runtime) {
      const persisted = this.db.getChatSession(chatId);
      runtime = {
        activeTurnId: null,
        activeTurnInput: null,
        activeTurnModel: null,
        activeTurnRetryCount: 0,
        currentThreadId: persisted?.threadId || null,
        currentThreadName: null,
        pendingTurnStart: false,
        tracker: null,
      };
      this.runtimeByChatId.set(chatId, runtime);
      if (persisted?.threadId) {
        this.chatIdByThreadId.set(persisted.threadId, chatId);
      }
    }
    return runtime;
  }

  private findTracker(threadId: string, turnId: string): TurnTracker | null {
    const chatId = this.chatIdByThreadId.get(threadId);
    if (!chatId) {
      return null;
    }

    const runtime = this.getOrCreateRuntime(chatId);
    if (runtime.currentThreadId !== threadId || !runtime.tracker) {
      return null;
    }

    if (runtime.activeTurnId === turnId) {
      return runtime.tracker;
    }

    if (runtime.pendingTurnStart && runtime.activeTurnId === null) {
      runtime.activeTurnId = turnId;
      runtime.pendingTurnStart = false;
      return runtime.tracker;
    }

    return null;
  }

  private async bindThreadToChat(
    chatId: number,
    threadId: string,
    threadName: string | null,
    options: { interruptCurrent: boolean },
  ): Promise<{ readonly alreadySelected: boolean; readonly interruptedCurrent: boolean; readonly blockedByChatId?: number }> {
    const runtime = this.getOrCreateRuntime(chatId);
    if (runtime.currentThreadId === threadId) {
      if (threadName) {
        runtime.currentThreadName = threadName;
        await this.touchDesktopSessionIndex(threadId, threadName);
      }
      this.db.saveChatSession(chatId, threadId);
      this.chatIdByThreadId.set(threadId, chatId);
      return { alreadySelected: true, interruptedCurrent: false };
    }

    const previousChatId = this.db.findChatIdByThreadId(threadId);
    if (previousChatId !== null && previousChatId !== chatId) {
      const previousRuntime = this.runtimeByChatId.get(previousChatId);
      if (previousRuntime?.currentThreadId === threadId && previousRuntime.activeTurnId) {
        return { alreadySelected: false, interruptedCurrent: false, blockedByChatId: previousChatId };
      }

      if (previousRuntime?.currentThreadId === threadId) {
        previousRuntime.currentThreadId = null;
        previousRuntime.currentThreadName = null;
        this.clearActiveTurn(previousRuntime);
      }
    }

    let interruptedCurrent = false;
    if (options.interruptCurrent && runtime.currentThreadId && runtime.activeTurnId && runtime.currentThreadId !== threadId) {
      await this.interruptRuntimeTurn(runtime, "switch session");
      interruptedCurrent = true;
    } else {
      this.clearActiveTurn(runtime);
    }

    runtime.currentThreadId = threadId;
    runtime.currentThreadName = threadName;
    this.db.saveChatSession(chatId, threadId);
    this.chatIdByThreadId.set(threadId, chatId);
    this.globalState.ensureWorkspaceThreadMapping(threadId, this.config.codexWorkspaceCwd);
    if (threadName) {
      await this.touchDesktopSessionIndex(threadId, threadName);
    }
    return { alreadySelected: false, interruptedCurrent };
  }

  private async interruptRuntimeTurn(runtime: ChatRuntimeState, reason: string): Promise<void> {
    if (!runtime.activeTurnId || !runtime.currentThreadId) {
      this.clearActiveTurn(runtime);
      return;
    }

    try {
      await this.codex.interruptTurn({ threadId: runtime.currentThreadId, turnId: runtime.activeTurnId });
    } catch (error) {
      console.warn(`Failed to interrupt current turn before ${reason}:`, error);
    }

    if (runtime.tracker) {
      await runtime.tracker.finish("interrupted");
    }
    this.clearActiveTurn(runtime);
  }

  private clearActiveTurn(runtime: ChatRuntimeState): void {
    runtime.activeTurnId = null;
    runtime.activeTurnInput = null;
    runtime.activeTurnModel = null;
    runtime.activeTurnRetryCount = 0;
    runtime.pendingTurnStart = false;
    runtime.tracker = null;
  }

  private async reconcileDesktopSessionIndex(): Promise<void> {
    for (const session of this.db.listChatSessions()) {
      const runtime = this.getOrCreateRuntime(session.chatId);
      try {
        const response = await this.codex.readThread(session.threadId);
        const existing = this.sessionIndex.get(session.threadId);
        const threadName =
          response.thread.name ||
          existing?.thread_name ||
          deriveThreadNameFromText(response.thread.preview) ||
          buildDefaultThreadName(response.thread.createdAt * 1000);
        runtime.currentThreadName = threadName;
        this.globalState.ensureWorkspaceThreadMapping(session.threadId, response.thread.cwd);

        if (!response.thread.name && threadName) {
          try {
            await this.codex.setThreadName(session.threadId, threadName);
          } catch (error) {
            console.warn(`Failed to persist thread name for ${session.threadId}:`, error);
          }
        }

        this.sessionIndex.upsert({
          id: session.threadId,
          thread_name: threadName,
          updated_at: new Date(response.thread.updatedAt * 1000).toISOString(),
        });
      } catch (error) {
        console.warn(`Failed to backfill session index for ${session.threadId}:`, error);
      }
    }
  }

  private async getCurrentThreadSummary(chatId: number): Promise<{ readonly id: string; readonly name: string } | null> {
    const runtime = this.getOrCreateRuntime(chatId);
    if (!runtime.currentThreadId) {
      return null;
    }

    const name = await this.resolveThreadName(runtime.currentThreadId, runtime.currentThreadName);
    runtime.currentThreadName = name;
    return { id: runtime.currentThreadId, name };
  }

  private async resolveThreadName(threadId: string, nameHint?: string | null): Promise<string> {
    if (nameHint) {
      return nameHint;
    }

    const indexed = this.sessionIndex.get(threadId);
    if (indexed?.thread_name) {
      return indexed.thread_name;
    }

    try {
      const response = await this.codex.readThread(threadId);
      const name =
        response.thread.name ||
        deriveThreadNameFromText(response.thread.preview) ||
        buildDefaultThreadName(response.thread.createdAt * 1000);
      this.globalState.ensureWorkspaceThreadMapping(threadId, response.thread.cwd);
      this.sessionIndex.upsert({
        id: threadId,
        thread_name: name,
        updated_at: new Date(response.thread.updatedAt * 1000).toISOString(),
      });
      return name;
    } catch (error) {
      console.warn(`Failed to resolve thread name for ${threadId}:`, error);
      return threadId;
    }
  }

  private async listWorkspaceSessions(): Promise<WorkspaceSessionChoice[]> {
    const hints = this.globalState.listThreadWorkspaceRootHints();
    const sessions: WorkspaceSessionChoice[] = [];
    const seen = new Set<string>();

    for (const entry of this.sessionIndex.readAll()) {
      if (seen.has(entry.id)) {
        continue;
      }
      seen.add(entry.id);

      const hintedRoot = hints[entry.id];
      if (hintedRoot) {
        if (!isPathWithinWorkspace(hintedRoot, this.config.codexWorkspaceCwd)) {
          continue;
        }

        sessions.push({
          id: entry.id,
          threadName: entry.thread_name,
          updatedAt: entry.updated_at,
        });
        continue;
      }

      try {
        const response = await this.codex.readThread(entry.id);
        this.globalState.ensureWorkspaceThreadMapping(entry.id, response.thread.cwd);
        if (!isPathWithinWorkspace(response.thread.cwd, this.config.codexWorkspaceCwd)) {
          continue;
        }

        const threadName =
          response.thread.name ||
          entry.thread_name ||
          deriveThreadNameFromText(response.thread.preview) ||
          buildDefaultThreadName(response.thread.createdAt * 1000);
        const updatedAt = new Date(response.thread.updatedAt * 1000).toISOString();
        if (threadName !== entry.thread_name || updatedAt !== entry.updated_at) {
          this.sessionIndex.upsert({
            id: entry.id,
            thread_name: threadName,
            updated_at: updatedAt,
          });
        }

        sessions.push({
          id: entry.id,
          threadName,
          updatedAt,
        });
      } catch (error) {
        console.warn(`Failed to inspect thread ${entry.id} while listing sessions:`, error);
      }
    }

    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return sessions;
  }

  private async showWorkspaceSessions(chatId: number, replyToMessageId: number, page: number): Promise<void> {
    const sessions = await this.listWorkspaceSessions();
    if (sessions.length === 0) {
      await this.telegram.sendMessage(
        chatId,
        "当前工作目录下还没有可选会话。先发送 /new 新建一个，再回来切换。",
        { replyToMessageId },
      );
      return;
    }

    const currentThreadId = this.getOrCreateRuntime(chatId).currentThreadId;
    const view = buildSessionPickerView(sessions, currentThreadId, page);
    await this.telegram.sendMessage(chatId, view.text, {
      replyMarkup: view.replyMarkup,
      replyToMessageId,
    });
  }

  private async handleSessionPickerPage(callbackQuery: TelegramCallbackQuery, rawPage: string): Promise<void> {
    const page = Number.parseInt(rawPage, 10);
    const message = callbackQuery.message;
    if (!message || !Number.isInteger(page) || page < 0) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效页码");
      return;
    }

    const sessions = await this.listWorkspaceSessions();
    if (sessions.length === 0) {
      await this.telegram.editMessageText(message.chat.id, message.message_id, "当前工作目录下还没有可选会话。");
      await this.telegram.answerCallbackQuery(callbackQuery.id, "没有可选会话");
      return;
    }

    const currentThreadId = this.getOrCreateRuntime(message.chat.id).currentThreadId;
    const view = buildSessionPickerView(sessions, currentThreadId, page);
    await this.telegram.editMessageText(message.chat.id, message.message_id, view.text, {
      replyMarkup: view.replyMarkup,
    });
    await this.telegram.answerCallbackQuery(callbackQuery.id);
  }

  private async handleSessionBinding(callbackQuery: TelegramCallbackQuery, threadId: string): Promise<void> {
    const message = callbackQuery.message;
    if (!message || !threadId) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效会话");
      return;
    }

    const sessions = await this.listWorkspaceSessions();
    const selected = sessions.find((session) => session.id === threadId);
    if (!selected) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "这个会话不在当前工作目录下");
      return;
    }

    const bindResult = await this.bindThreadToChat(message.chat.id, selected.id, selected.threadName, {
      interruptCurrent: true,
    });
    if (bindResult.blockedByChatId !== undefined) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "这个会话正在另一个聊天里运行");
      return;
    }

    const lines = [bindResult.alreadySelected ? "当前聊天已经绑定这个会话。" : `已切换到会话：${selected.threadName}`];
    lines.push(`线程：${selected.id}`);
    if (bindResult.interruptedCurrent) {
      lines.push("", "原来的进行中回合已中断。");
    }

    await this.telegram.editMessageText(message.chat.id, message.message_id, lines.join("\n"));
    await this.telegram.answerCallbackQuery(
      callbackQuery.id,
      bindResult.alreadySelected ? "已经是当前会话" : "已切换会话",
    );
  }

  private async handleSkillPickerPage(callbackQuery: TelegramCallbackQuery, rawPage: string): Promise<void> {
    const message = callbackQuery.message;
    const page = Number.parseInt(rawPage, 10);
    if (!message || !Number.isInteger(page) || page < 0) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效页码");
      return;
    }

    const threadId = this.getOrCreateRuntime(message.chat.id).currentThreadId;
    if (!threadId) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "当前没有会话");
      return;
    }

    await this.refreshSkillPickerMessage(message.chat.id, message.message_id, threadId, page);
    await this.telegram.answerCallbackQuery(callbackQuery.id);
  }

  private async handleSkillToggle(callbackQuery: TelegramCallbackQuery, rawPayload: string): Promise<void> {
    const message = callbackQuery.message;
    const [pageRaw = "", encodedName = ""] = rawPayload.split(":", 2);
    const page = Number.parseInt(pageRaw, 10);
    if (!message || !Number.isInteger(page) || page < 0 || !encodedName) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效技能");
      return;
    }

    let skillName = "";
    try {
      skillName = decodeURIComponent(encodedName);
    } catch {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效技能");
      return;
    }

    const threadId = this.getOrCreateRuntime(message.chat.id).currentThreadId;
    if (!threadId) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "当前没有会话");
      return;
    }

    const state = await this.buildSkillPickerState(threadId);
    const selectedNames = new Set(state.selectedSkills.map((skill) => skill.skillName));
    const targetSkill = state.skills.find((skill) => skill.name === skillName);

    if (!targetSkill && !selectedNames.has(skillName)) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "技能不存在");
      return;
    }

    let answerText = "已更新技能";
    if (selectedNames.has(skillName)) {
      this.db.deleteSelectedSkill(threadId, skillName);
      answerText = `已取消 ${skillName}`;
    } else if (targetSkill?.available) {
      this.db.saveSelectedSkill(threadId, targetSkill.name, targetSkill.path);
      answerText = `已选择 ${targetSkill.name}`;
    } else {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "这个技能当前不可用");
      return;
    }

    await this.refreshSkillPickerMessage(message.chat.id, message.message_id, threadId, page);
    await this.telegram.answerCallbackQuery(
      callbackQuery.id,
      state.hasActiveTurn ? `${answerText}，下轮生效` : answerText,
    );
  }

  private async handleSkillClear(callbackQuery: TelegramCallbackQuery, rawPage: string): Promise<void> {
    const message = callbackQuery.message;
    const page = Number.parseInt(rawPage, 10);
    if (!message || !Number.isInteger(page) || page < 0) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效请求");
      return;
    }

    const threadId = this.getOrCreateRuntime(message.chat.id).currentThreadId;
    if (!threadId) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "当前没有会话");
      return;
    }

    this.db.clearSelectedSkills(threadId);
    await this.refreshSkillPickerMessage(message.chat.id, message.message_id, threadId, page);
    const runtime = this.getOrCreateRuntime(message.chat.id);
    await this.telegram.answerCallbackQuery(
      callbackQuery.id,
      runtime.currentThreadId === threadId && runtime.activeTurnId ? "已清空，下轮生效" : "已清空当前会话技能",
    );
  }

  private async handleModelPickerRefresh(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const message = callbackQuery.message;
    if (!message) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效请求");
      return;
    }

    await this.refreshModelPickerMessage(message.chat.id, message.message_id);
    await this.telegram.answerCallbackQuery(callbackQuery.id, "已刷新");
  }

  private async handleModelAutoSelect(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const message = callbackQuery.message;
    if (!message) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效请求");
      return;
    }

    await this.telegram.answerCallbackQuery(callbackQuery.id, "正在探活候选模型...");
    await this.telegram.editMessageText(message.chat.id, message.message_id, `${this.renderModelSummary()}\n\n正在按候选链重新探活...`);

    try {
      this.unavailableCodexModels.clear();
      await this.resolveActiveCodexModel();
      await this.refreshModelPickerMessage(message.chat.id, message.message_id);
    } catch (error) {
      await this.telegram.editMessageText(
        message.chat.id,
        message.message_id,
        `${this.renderModelSummary()}\n\n自动探活失败：${getErrorMessage(error)}`,
        { replyMarkup: this.buildModelPickerView(message.chat.id).replyMarkup },
      );
    }
  }

  private async handleModelSelect(callbackQuery: TelegramCallbackQuery, rawModel: string): Promise<void> {
    const message = callbackQuery.message;
    const model = decodeURIComponent(rawModel).trim();
    if (!message || !model || !this.codexModelCandidates.includes(model)) {
      await this.telegram.answerCallbackQuery(callbackQuery.id, "无效模型");
      return;
    }

    await this.telegram.answerCallbackQuery(callbackQuery.id, `正在探活 ${model}...`);
    await this.telegram.editMessageText(message.chat.id, message.message_id, `${this.renderModelSummary()}\n\n正在探活：${model}`);

    try {
      await this.codex.probeModel({
        model,
        cwd: this.config.codexWorkspaceCwd,
        serviceName: `${this.config.serviceName}_model_manual_probe`,
        timeoutMs: this.config.codexModelProbeTimeoutMs,
      });
      this.unavailableCodexModels.delete(model);
      this.activeCodexModel = model;
      await this.refreshModelPickerMessage(message.chat.id, message.message_id);
    } catch (error) {
      this.unavailableCodexModels.add(model);
      await this.telegram.editMessageText(
        message.chat.id,
        message.message_id,
        `${this.renderModelSummary()}\n\n模型 ${model} 探活失败：${getErrorMessage(error)}`,
        { replyMarkup: this.buildModelPickerView(message.chat.id).replyMarkup },
      );
    }
  }

  private async ensureThreadForSkills(message: TelegramMessage): Promise<string | null> {
    const runtime = this.getOrCreateRuntime(message.chat.id);
    if (runtime.currentThreadId) {
      return runtime.currentThreadId;
    }

    if (message.chat.type !== "private") {
      await this.telegram.sendMessage(
        message.chat.id,
        "这个聊天还没有绑定会话。发送 /sessions 选择已有会话，或发送 /new 新建一个，再来选技能。",
        { replyToMessageId: message.message_id },
      );
      return null;
    }

    return this.createNewThread(message.chat.id, false);
  }

  private async buildIncomingMessagePayload(message: TelegramMessage): Promise<IncomingMessagePayload | null> {
    const text = getTelegramMessageText(message);
    const document = message.document;
    if (document && !isTelegramImageDocument(document)) {
      return null;
    }

    const inputs: UserInput[] = [];
    const localImagePath = await this.resolveIncomingImagePath(message);
    if (localImagePath) {
      inputs.push({ type: "localImage", path: localImagePath });
    }
    if (text) {
      inputs.push({ type: "text", text, text_elements: [] });
    }

    if (inputs.length === 0) {
      return null;
    }

    return {
      inputs,
      namingText: text || null,
    };
  }

  private async resolveIncomingImagePath(message: TelegramMessage): Promise<string | null> {
    const photo = selectLargestTelegramPhoto(message.photo);
    if (photo) {
      return this.downloadTelegramFileToLocalPath(photo.file_id, message, {
        fileSize: photo.file_size,
        originalFileName: `${photo.file_unique_id}.jpg`,
      });
    }

    const document = message.document;
    if (!document || !isTelegramImageDocument(document)) {
      return null;
    }

    return this.downloadTelegramFileToLocalPath(document.file_id, message, {
      fileSize: document.file_size,
      originalFileName: document.file_name,
      mimeType: document.mime_type,
    });
  }

  private async downloadTelegramFileToLocalPath(
    fileId: string,
    message: TelegramMessage,
    options: {
      readonly fileSize?: number;
      readonly originalFileName?: string;
      readonly mimeType?: string;
    },
  ): Promise<string> {
    if (options.fileSize && options.fileSize > MAX_TELEGRAM_IMAGE_BYTES) {
      throw new Error("图片太大了，暂时只支持 20MB 以内的图片。");
    }

    await fs.mkdir(this.telegramFileDir, { recursive: true });
    await this.maybeCleanupTelegramFileCache();

    const telegramFile = await this.telegram.getFile(fileId);
    if (!telegramFile.file_path) {
      throw new Error("Telegram 没有返回图片下载路径。");
    }

    if (telegramFile.file_size && telegramFile.file_size > MAX_TELEGRAM_IMAGE_BYTES) {
      throw new Error("图片太大了，暂时只支持 20MB 以内的图片。");
    }

    const extension = chooseTelegramImageExtension(
      options.originalFileName,
      telegramFile.file_path,
      options.mimeType,
    );
    const localPath = path.join(
      this.telegramFileDir,
      `${message.chat.id}-${message.message_id}-${randomUUID()}${extension}`,
    );

    await this.telegram.downloadFileToPath(telegramFile.file_path, localPath);
    return localPath;
  }

  private async maybeCleanupTelegramFileCache(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTelegramFileCleanupAt < TELEGRAM_FILE_CACHE_CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastTelegramFileCleanupAt = now;

    try {
      const entries = await fs.readdir(this.telegramFileDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        const filePath = path.join(this.telegramFileDir, entry.name);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > TELEGRAM_FILE_CACHE_TTL_MS) {
            await fs.unlink(filePath);
          }
        } catch (error) {
          console.warn(`Failed to inspect cached Telegram file ${filePath}:`, error);
        }
      }
    } catch (error) {
      console.warn(`Failed to clean Telegram file cache at ${this.telegramFileDir}:`, error);
    }
  }

  private async buildTurnInputs(threadId: string, inputs: UserInput[]): Promise<UserInput[]> {
    const selectedSkillInputs = await this.resolveSelectedSkillInputs(threadId);
    return [...selectedSkillInputs, ...inputs];
  }

  private async resolveSelectedSkillInputs(threadId: string): Promise<Array<Extract<UserInput, { type: "skill" }>>> {
    const selectedSkills = this.db.listSelectedSkills(threadId);
    if (selectedSkills.length === 0) {
      return [];
    }

    try {
      const { skills } = await this.listAvailableSkills(false);
      const availableByName = new Map(skills.filter((skill) => skill.available).map((skill) => [skill.name, skill]));
      const inputs: Array<Extract<UserInput, { type: "skill" }>> = [];

      for (const selectedSkill of selectedSkills) {
        const availableSkill = availableByName.get(selectedSkill.skillName);
        if (!availableSkill) {
          continue;
        }

        if (availableSkill.path !== selectedSkill.skillPath) {
          this.db.saveSelectedSkill(threadId, availableSkill.name, availableSkill.path);
        }

        inputs.push({
          type: "skill",
          name: availableSkill.name,
          path: availableSkill.path,
        });
      }

      return inputs;
    } catch (error) {
      console.warn(`Failed to validate selected skills for ${threadId}:`, error);
      return selectedSkills.map((skill) => ({
        type: "skill",
        name: skill.skillName,
        path: skill.skillPath,
      }));
    }
  }

  private async listAvailableSkills(forceReload: boolean): Promise<{ readonly skills: AvailableSkillChoice[]; readonly errorCount: number }> {
    const response = await this.codex.listSkills({
      cwds: [this.config.codexWorkspaceCwd],
      forceReload,
    });

    const byName = new Map<string, AvailableSkillChoice>();
    let errorCount = 0;

    for (const entry of response.data) {
      if (!isSkillEntryForWorkspace(entry.cwd, this.config.codexWorkspaceCwd)) {
        continue;
      }

      errorCount += entry.errors.length;
      for (const skill of entry.skills) {
        if (!skill.enabled) {
          continue;
        }

        const choice = toAvailableSkillChoice(skill);
        if (!byName.has(choice.name)) {
          byName.set(choice.name, choice);
        }
      }
    }

    const skills = [...byName.values()].sort((left, right) =>
      compareText(left.displayName, right.displayName) || compareText(left.name, right.name),
    );

    return { skills, errorCount };
  }

  private async buildSkillPickerState(threadId: string): Promise<SkillPickerState> {
    const selectedSkills = this.db.listSelectedSkills(threadId);
    const selectedNames = new Set(selectedSkills.map((skill) => skill.skillName));
    let availableSkills: AvailableSkillChoice[] = [];
    let errorCount = 0;
    let catalogError: string | null = null;

    try {
      const catalog = await this.listAvailableSkills(true);
      availableSkills = catalog.skills;
      errorCount = catalog.errorCount;
    } catch (error) {
      catalogError = error instanceof Error ? error.message : "未知错误";
      console.warn(`Failed to list skills for ${threadId}:`, error);
    }

    const availableByName = new Map(availableSkills.map((skill) => [skill.name, skill]));
    const mergedSkills = [...availableSkills];
    for (const selectedSkill of selectedSkills) {
      if (!availableByName.has(selectedSkill.skillName)) {
        mergedSkills.push({
          name: selectedSkill.skillName,
          displayName: selectedSkill.skillName,
          description: "当前已选，但现在不可用。",
          path: selectedSkill.skillPath,
          scope: "stored",
          available: false,
        });
      }
    }

    mergedSkills.sort((left, right) => {
      const selectedOrder = Number(selectedNames.has(right.name)) - Number(selectedNames.has(left.name));
      if (selectedOrder !== 0) {
        return selectedOrder;
      }

      const availabilityOrder = Number(right.available) - Number(left.available);
      if (availabilityOrder !== 0) {
        return availabilityOrder;
      }

      return compareText(left.displayName, right.displayName) || compareText(left.name, right.name);
    });

    const threadName = await this.resolveThreadName(threadId);
    const chatId = this.chatIdByThreadId.get(threadId);
    const runtime = chatId !== undefined ? this.getOrCreateRuntime(chatId) : null;
    return {
      threadId,
      threadName,
      skills: mergedSkills,
      selectedSkills,
      errorCount,
      hasActiveTurn: runtime?.currentThreadId === threadId && runtime.activeTurnId !== null,
      catalogError,
    };
  }

  private async showThreadSkills(chatId: number, replyToMessageId: number, threadId: string, page: number): Promise<void> {
    const state = await this.buildSkillPickerState(threadId);
    const view = buildSkillPickerView(state, page);
    await this.telegram.sendMessage(chatId, view.text, {
      replyMarkup: view.replyMarkup,
      replyToMessageId,
    });
  }

  private async refreshSkillPickerMessage(
    chatId: number,
    messageId: number,
    threadId: string,
    page: number,
  ): Promise<void> {
    const state = await this.buildSkillPickerState(threadId);
    const view = buildSkillPickerView(state, page);
    await this.telegram.editMessageText(chatId, messageId, view.text, {
      replyMarkup: view.replyMarkup,
    });
  }

  private async refreshModelPickerMessage(chatId: number, messageId: number): Promise<void> {
    const view = this.buildModelPickerView(chatId);
    await this.telegram.editMessageText(chatId, messageId, view.text, {
      replyMarkup: view.replyMarkup,
    });
  }

  private buildModelPickerView(chatId: number): { readonly text: string; readonly replyMarkup: TelegramReplyMarkup } {
    const runtime = this.getOrCreateRuntime(chatId);
    const lines = [this.renderModelSummary()];

    if (runtime.activeTurnId || runtime.pendingTurnStart) {
      lines.push("", "提示：当前回合进行中，切换模型会从下一轮开始生效。");
    }

    if (this.unavailableCodexModels.size > 0) {
      lines.push("", `本进程已标记不可用：${[...this.unavailableCodexModels].join(", ")}`);
    }

    lines.push("", "选择模型：");
    const rows: TelegramInlineKeyboardButton[][] = this.codexModelCandidates.map((model) => {
      const isActive = model === this.activeCodexModel;
      const unavailable = this.unavailableCodexModels.has(model);
      const prefix = isActive ? "[当前] " : unavailable ? "[不可用] " : "";
      return [
        {
          text: truncateButtonLabel(`${prefix}${model}`, 32),
          callback_data: `ms:${encodeURIComponent(model)}`,
        },
      ];
    });

    rows.push([{ text: "自动探活选择", callback_data: "ma:auto" }]);
    rows.push([{ text: "刷新", callback_data: "mp:refresh" }]);

    return {
      text: lines.join("\n"),
      replyMarkup: { inline_keyboard: rows },
    };
  }

  private renderSelectedSkillsSummary(threadId: string): string {
    return renderSelectedSkillsSummaryFromRows(this.db.listSelectedSkills(threadId), "当前技能");
  }

  private renderModelSummary(): string {
    const active = this.activeCodexModel || "尚未完成探活";
    const candidates = this.codexModelCandidates.length > 0 ? `\n候选模型：${this.codexModelCandidates.join(" -> ")}` : "";
    return `当前模型：${active}${candidates}`;
  }

  private async ensureThreadNamedForDesktop(
    runtime: ChatRuntimeState,
    threadId: string,
    userText: string,
  ): Promise<void> {
    const desiredName = deriveThreadNameFromText(userText);
    if (!desiredName) {
      return;
    }

    if (runtime.currentThreadName && !isAutoGeneratedThreadName(runtime.currentThreadName)) {
      return;
    }

    if (runtime.currentThreadName === desiredName) {
      return;
    }

    try {
      await this.codex.setThreadName(threadId, desiredName);
      runtime.currentThreadName = desiredName;
      this.globalState.ensureWorkspaceThreadMapping(threadId, this.config.codexWorkspaceCwd);
      this.sessionIndex.upsert({
        id: threadId,
        thread_name: desiredName,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(`Failed to name thread ${threadId}:`, error);
    }
  }

  private async touchDesktopSessionIndex(threadId: string, threadName?: string | null): Promise<void> {
    const existing = this.sessionIndex.get(threadId);
    const name = threadName || existing?.thread_name;
    if (!name) {
      return;
    }

    this.sessionIndex.upsert({
      id: threadId,
      thread_name: name,
      updated_at: new Date().toISOString(),
    });
    this.globalState.ensureWorkspaceThreadMapping(threadId, this.config.codexWorkspaceCwd);
  }
}

function buildApprovalKeyboard(
  token: string,
  kind: "commandApproval" | "fileApproval",
  params: CommandExecutionRequestApprovalParams | FileChangeRequestApprovalParams,
): TelegramReplyMarkup {
  const decisions = new Set<string>();
  if ("availableDecisions" in params && Array.isArray(params.availableDecisions) && params.availableDecisions.length > 0) {
    for (const decision of params.availableDecisions) {
      if (typeof decision === "string") {
        decisions.add(decision);
      }
    }
  } else {
    decisions.add("accept");
    decisions.add("decline");
    decisions.add("cancel");
  }

  const buttons: TelegramInlineKeyboardButton[] = [];
  const order = ["accept", "acceptForSession", "decline", "cancel"];
  for (const decision of order) {
    if (decisions.has(decision)) {
      buttons.push({
        text: renderDecisionLabel(decision),
        callback_data: `ap:${token}:${decision}`,
      });
    }
  }

  return {
    inline_keyboard: chunkButtons(buttons, kind === "commandApproval" ? 2 : 2),
  };
}

function buildToolUserInputKeyboard(token: string, options: NonNullable<ToolRequestUserInputParams["questions"][number]["options"]>): TelegramReplyMarkup {
  return {
    inline_keyboard: options.map((option, index) => [
      {
        text: option.label,
        callback_data: `iu:${token}:${index}`,
      },
    ]),
  };
}

function renderApprovalPrompt(
  kind: "commandApproval" | "fileApproval",
  params: CommandExecutionRequestApprovalParams | FileChangeRequestApprovalParams,
): string {
  const lines = [kind === "commandApproval" ? "Codex 请求执行一个命令：" : "Codex 请求应用文件修改："];

  if ("command" in params && params.command) {
    lines.push(params.command);
  }
  if ("cwd" in params && params.cwd) {
    lines.push(`cwd: ${params.cwd}`);
  }
  if (params.reason) {
    lines.push(`原因：${params.reason}`);
  }
  if ("networkApprovalContext" in params && params.networkApprovalContext) {
      lines.push(`网络访问：${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}`);
  }
  if (kind === "fileApproval" && "grantRoot" in params && params.grantRoot) {
    lines.push(`授权根目录：${params.grantRoot}`);
  }

  lines.push("", "请选择是否放行。");
  return lines.join("\n");
}

function renderToolUserInputPrompt(questions: ToolRequestUserInputParams["questions"]): string {
  const lines = ["Codex 需要你补充输入：", ""];

  if (questions.length === 1) {
    const [question] = questions;
    if (question) {
      lines.push(`${question.header}: ${question.question}`);
      if (question.options?.length) {
        lines.push("", "也可以直接点击下面的选项。");
      } else {
        lines.push("", "直接回复这条消息即可。");
      }
    }
    return lines.join("\n");
  }

  for (const question of questions) {
    lines.push(`${question.id} (${question.header}): ${question.question}`);
  }

  lines.push("", "请按 `问题ID: 回答` 的格式逐行回复。");
  return lines.join("\n");
}

function parseStructuredAnswers(
  questions: ToolRequestUserInputParams["questions"],
  raw: string,
): Record<string, { answers: string[] }> | null {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const answers: Record<string, { answers: string[] }> = {};

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) {
      return null;
    }

    const id = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (!value || !byId.has(id)) {
      return null;
    }

    answers[id] = { answers: [value] };
  }

  for (const question of questions) {
    if (!answers[question.id]) {
      return null;
    }
  }

  return answers;
}

function renderDecisionLabel(decision: string): string {
  switch (decision) {
    case "accept":
      return "接受";
    case "acceptForSession":
      return "本会话一直接受";
    case "decline":
      return "拒绝";
    case "cancel":
      return "取消本轮";
    default:
      return decision;
  }
}

function renderPendingRequestText(pending: PendingRequestRow): string {
  const payload = pending.payloadJson ? JSON.parse(pending.payloadJson) : null;
  if (pending.kind === "commandApproval" && payload && typeof payload.command === "string") {
    return `Codex 请求执行命令：\n${payload.command}`;
  }
  if (pending.kind === "fileApproval") {
    return "Codex 请求应用文件修改。";
  }
  if (pending.kind === "toolUserInput") {
    return "Codex 请求补充输入。";
  }
  return "Codex 请求交互。";
}

function chunkButtons(buttons: TelegramInlineKeyboardButton[], width: number): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (let index = 0; index < buttons.length; index += width) {
    rows.push(buttons.slice(index, index + width));
  }
  return rows;
}

function getTelegramMessageText(message: TelegramMessage): string {
  return message.text?.trim() || message.caption?.trim() || "";
}

function hasTelegramImage(message: TelegramMessage): boolean {
  return Boolean(selectLargestTelegramPhoto(message.photo) || (message.document && isTelegramImageDocument(message.document)));
}

function selectLargestTelegramPhoto(photos?: TelegramPhotoSize[]): TelegramPhotoSize | null {
  if (!photos || photos.length === 0) {
    return null;
  }

  return [...photos].sort((left, right) => {
    const sizeDelta = (right.file_size || 0) - (left.file_size || 0);
    if (sizeDelta !== 0) {
      return sizeDelta;
    }

    return right.width * right.height - left.width * left.height;
  })[0] || null;
}

function isTelegramImageDocument(document: TelegramDocument): boolean {
  if (document.mime_type?.startsWith("image/")) {
    return true;
  }

  const extension = path.extname(document.file_name || "").toLowerCase();
  return IMAGE_DOCUMENT_EXTENSIONS.has(extension);
}

function chooseTelegramImageExtension(
  originalFileName: string | undefined,
  telegramFilePath: string | undefined,
  mimeType: string | undefined,
): string {
  const candidates = [
    path.extname(originalFileName || ""),
    path.extname(telegramFilePath || ""),
    inferExtensionFromMimeType(mimeType),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeImageExtension(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return ".png";
}

function normalizeImageExtension(extension: string | undefined): string | null {
  if (!extension) {
    return null;
  }

  const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  return normalized.length > 1 ? normalized : null;
}

function inferExtensionFromMimeType(mimeType: string | undefined): string | undefined {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
      return ".tiff";
    default:
      return undefined;
  }
}

async function collectGeneratedImagePathsFromCommandExecution(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
): Promise<string[]> {
  const candidates = new Set<string>([
    ...extractAbsoluteImagePaths(item.command),
    ...extractAbsoluteImagePaths(item.aggregatedOutput || ""),
  ]);

  if (candidates.size === 0) {
    return [];
  }

  const now = Date.now();
  const freshImages: string[] = [];
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isFile()) {
        continue;
      }
      if (stats.size <= 0 || now - stats.mtimeMs > GENERATED_IMAGE_FRESH_WINDOW_MS) {
        continue;
      }

      freshImages.push(candidate);
    } catch {
      continue;
    }
  }

  freshImages.sort();
  return freshImages;
}

function extractAbsoluteImagePaths(text: string): string[] {
  if (!text) {
    return [];
  }

  const matches = text.match(ABSOLUTE_IMAGE_PATH_PATTERN) || [];
  return matches
    .map((match) => sanitizeExtractedPath(match))
    .filter((value): value is string => value !== null);
}

function sanitizeExtractedPath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/[),.:;!?]+$/g, "");
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const extension = path.extname(trimmed).toLowerCase();
  if (!IMAGE_DOCUMENT_EXTENSIONS.has(extension)) {
    return null;
  }

  return trimmed;
}

function buildSessionPickerView(
  sessions: WorkspaceSessionChoice[],
  currentThreadId: string | null,
  page: number,
): { readonly text: string; readonly replyMarkup: TelegramReplyMarkup } {
  const totalPages = Math.max(1, Math.ceil(sessions.length / SESSION_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageStart = safePage * SESSION_PAGE_SIZE;
  const pageSessions = sessions.slice(pageStart, pageStart + SESSION_PAGE_SIZE);
  const current = currentThreadId ? sessions.find((session) => session.id === currentThreadId) : null;

  const lines = [
    `当前会话：${current?.threadName || currentThreadId || "未绑定"}`,
  ];
  if (currentThreadId) {
    lines.push(`线程：${currentThreadId}`);
  }

  lines.push("", "选择要绑定到当前聊天的会话：", "");
  for (const [index, session] of pageSessions.entries()) {
    const marker = session.id === currentThreadId ? " [当前]" : "";
    lines.push(`${pageStart + index + 1}. ${session.threadName}${marker}`);
    lines.push(`最近更新：${formatSessionTimestamp(session.updatedAt)}`);
  }
  lines.push("", `第 ${safePage + 1} / ${totalPages} 页`);

  const rows: TelegramInlineKeyboardButton[][] = pageSessions.map((session) => [
    {
      text: truncateButtonLabel(`${session.id === currentThreadId ? "当前: " : ""}${session.threadName}`, 30),
      callback_data: `sb:${session.id}`,
    },
  ]);

  const navRow: TelegramInlineKeyboardButton[] = [];
  if (safePage > 0) {
    navRow.push({ text: "上一页", callback_data: `sp:${safePage - 1}` });
  }
  navRow.push({ text: "刷新", callback_data: `sp:${safePage}` });
  if (safePage + 1 < totalPages) {
    navRow.push({ text: "下一页", callback_data: `sp:${safePage + 1}` });
  }
  rows.push(navRow);

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: rows,
    },
  };
}

function buildSkillPickerView(
  state: SkillPickerState,
  page: number,
): { readonly text: string; readonly replyMarkup: TelegramReplyMarkup } {
  const selectedNames = new Set(state.selectedSkills.map((skill) => skill.skillName));
  const totalPages = Math.max(1, Math.ceil(state.skills.length / SKILL_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageStart = safePage * SKILL_PAGE_SIZE;
  const pageSkills = state.skills.slice(pageStart, pageStart + SKILL_PAGE_SIZE);

  const lines = [
    `当前会话：${state.threadName}`,
    `线程：${state.threadId}`,
    renderSelectedSkillsSummaryFromRows(state.selectedSkills, "已选技能"),
  ];

  if (state.hasActiveTurn) {
    lines.push("提示：当前回合进行中，技能改动会从下一轮开始生效。");
  }
  if (state.errorCount > 0) {
    lines.push(`提示：有 ${state.errorCount} 个技能加载失败，未显示在列表中。`);
  }
  if (state.catalogError) {
    lines.push(`提示：技能目录读取失败：${state.catalogError}`);
  }

  lines.push("", "点击切换当前会话的技能：", "");
  if (pageSkills.length === 0) {
    lines.push("当前工作目录下没有可选技能。");
  } else {
    for (const [index, skill] of pageSkills.entries()) {
      const selected = selectedNames.has(skill.name);
      const status = selected ? "[已选]" : skill.available ? "[可选]" : "[不可用]";
      lines.push(`${pageStart + index + 1}. ${status} ${skill.displayName} [${skill.scope}]`);
      lines.push(truncateLine(skill.description, 80));
    }
  }
  lines.push("", `第 ${safePage + 1} / ${totalPages} 页`);

  const rows: TelegramInlineKeyboardButton[][] = pageSkills.map((skill) => [
    {
      text: truncateButtonLabel(
        `${selectedNames.has(skill.name) ? "[x]" : "[ ]"} ${skill.displayName}`,
        30,
      ),
      callback_data: `kt:${safePage}:${encodeURIComponent(skill.name)}`,
    },
  ]);

  const navRow: TelegramInlineKeyboardButton[] = [];
  if (safePage > 0) {
    navRow.push({ text: "上一页", callback_data: `kg:${safePage - 1}` });
  }
  navRow.push({ text: "刷新", callback_data: `kg:${safePage}` });
  if (safePage + 1 < totalPages) {
    navRow.push({ text: "下一页", callback_data: `kg:${safePage + 1}` });
  }
  rows.push(navRow);

  if (state.selectedSkills.length > 0) {
    rows.push([{ text: "清空全部", callback_data: `kc:${safePage}` }]);
  }

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: rows,
    },
  };
}

function parseBotCommand(
  text: string,
  botUsername: string | null,
): { readonly command: string; readonly addressedToCurrentBot: boolean } | null {
  const match = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s|$)/.exec(text);
  if (!match) {
    return null;
  }

  const [, rawCommand = "", rawTarget] = match;
  if (!rawCommand) {
    return null;
  }

  if (rawTarget && botUsername && rawTarget.toLowerCase() !== botUsername.toLowerCase()) {
    return { command: rawCommand.toLowerCase(), addressedToCurrentBot: false };
  }

  return { command: rawCommand.toLowerCase(), addressedToCurrentBot: true };
}

function isSupportedChatType(chatType: string): boolean {
  return chatType === "private" || chatType === "group" || chatType === "supergroup";
}

function isSupportedCommand(command: string): boolean {
  return (
    command === "start" ||
    command === "new" ||
    command === "current" ||
    command === "sessions" ||
    command === "skills" ||
    command === "model"
  );
}

function isPathWithinWorkspace(candidatePath: string, workspaceRoot: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const relative = path.relative(resolvedWorkspaceRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSkillEntryForWorkspace(entryCwd: string, workspaceRoot: string): boolean {
  const resolvedEntry = path.resolve(entryCwd);
  const resolvedWorkspace = path.resolve(workspaceRoot);
  return resolvedEntry === resolvedWorkspace || isPathWithinWorkspace(resolvedEntry, resolvedWorkspace);
}

function formatSessionTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function truncateButtonLabel(label: string, maxLength: number): string {
  return label.length <= maxLength ? label : `${label.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function truncateLine(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "暂无描述";
  }

  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function renderSelectedSkillsSummaryFromRows(
  selectedSkills: ThreadSelectedSkill[],
  label: string,
): string {
  if (selectedSkills.length === 0) {
    return `${label}：未选择`;
  }

  const preview = selectedSkills.slice(0, 4).map((skill) => skill.skillName).join(", ");
  return selectedSkills.length <= 4
    ? `${label}：${preview}`
    : `${label}：${preview} 等 ${selectedSkills.length} 个`;
}

function toAvailableSkillChoice(skill: SkillMetadata): AvailableSkillChoice {
  return {
    name: skill.name,
    displayName: skill.interface?.displayName || skill.name,
    description: pickSkillDescription(skill),
    path: skill.path,
    scope: formatSkillScope(skill.scope),
    available: true,
  };
}

function pickSkillDescription(skill: SkillMetadata): string {
  return (
    skill.interface?.shortDescription ||
    skill.shortDescription ||
    skill.description ||
    "暂无描述"
  );
}

function formatSkillScope(scope: SkillMetadata["scope"] | "stored"): string {
  switch (scope) {
    case "repo":
      return "repo";
    case "user":
      return "user";
    case "system":
      return "system";
    case "admin":
      return "admin";
    case "stored":
      return "stored";
    default:
      return String(scope);
  }
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-CN");
}

function createShortToken(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function deriveThreadNameFromText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length <= 40 ? normalized : `${normalized.slice(0, 40).trimEnd()}...`;
}

function buildDefaultThreadName(timestamp = Date.now()): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `TG 对话 ${formatter.format(new Date(timestamp)).replace(/\//g, "-")}`;
}

function isAutoGeneratedThreadName(name: string): boolean {
  return name.startsWith("TG 对话 ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
