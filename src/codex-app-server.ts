import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import type { InitializeParams } from "./generated/InitializeParams";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { RequestId } from "./generated/RequestId";
import type { ServerNotification } from "./generated/ServerNotification";
import type { ServerRequest } from "./generated/ServerRequest";
import type { InitializeCapabilities } from "./generated/InitializeCapabilities";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { LoginAccountParams } from "./generated/v2/LoginAccountParams";
import type { ModelListResponse } from "./generated/v2/ModelListResponse";
import type { SkillsListParams } from "./generated/v2/SkillsListParams";
import type { SkillsListResponse } from "./generated/v2/SkillsListResponse";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { ThreadSetNameResponse } from "./generated/v2/ThreadSetNameResponse";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse";
import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams";
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse";

interface JsonRpcSuccess<T> {
  readonly id: RequestId;
  readonly result: T;
}

interface JsonRpcErrorShape {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

interface JsonRpcFailure {
  readonly id?: RequestId;
  readonly error: JsonRpcErrorShape;
}

type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
};

export interface CodexAppServerOptions {
  readonly codexBin: string;
  readonly openaiApiKey?: string;
}

export interface ModelProbeOptions {
  readonly model: string;
  readonly cwd: string;
  readonly serviceName: string;
  readonly timeoutMs: number;
}

export class CodexAppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private initialized = false;

  public constructor(private readonly options: CodexAppServerOptions) {
    super();
  }

  public async start(): Promise<InitializeResponse> {
    if (this.process) {
      throw new Error("Codex app-server is already running");
    }

    this.process = spawn(this.options.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const child = this.process;
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    child.on("exit", (code, signal) => {
      const pendingEntries = [...this.pending.values()];
      this.pending.clear();
      for (const pending of pendingEntries) {
        pending.reject(new Error("Codex app-server exited before responding"));
      }
      this.process = null;
      this.reader = null;
      this.initialized = false;
      this.emit("exit", code, signal);
    });

    this.reader = createInterface({ input: child.stdout });
    this.reader.on("line", (line) => {
      void this.handleLine(line);
    });

    const capabilities: InitializeCapabilities = {
      experimentalApi: true,
    };
    const params: InitializeParams = {
      clientInfo: {
        name: "telegram_codex_bridge",
        title: "Telegram Codex Bridge",
        version: "0.1.0",
      },
      capabilities,
    };

    const response = await this.request<InitializeResponse>("initialize", params);
    this.initialized = true;
    return response;
  }

  public async close(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  public async ensureAuthenticated(): Promise<GetAccountResponse> {
    const account = await this.request<GetAccountResponse>("account/read", { refreshToken: false });
    if (account.account || !account.requiresOpenaiAuth) {
      return account;
    }

    if (!this.options.openaiApiKey) {
      throw new Error(
        "Codex is not authenticated. Sign in with the local Codex app or set OPENAI_API_KEY in your external bridge config.",
      );
    }

    const loginCompleted = this.waitForNotification(
      "account/login/completed",
      (notification) => notification.params.success === true,
      15_000,
    );
    const loginParams: LoginAccountParams = { type: "apiKey", apiKey: this.options.openaiApiKey };
    await this.request("account/login/start", loginParams);
    await loginCompleted;

    return this.request<GetAccountResponse>("account/read", { refreshToken: false });
  }

  public async listModels(): Promise<ModelListResponse> {
    return this.request<ModelListResponse>("model/list", { limit: 20, includeHidden: false });
  }

  public async listSkills(params: SkillsListParams): Promise<SkillsListResponse> {
    return this.request<SkillsListResponse>("skills/list", params);
  }

  public async readThread(threadId: string): Promise<ThreadReadResponse> {
    return this.request<ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns: false,
    });
  }

  public async startThread(params: Omit<ThreadStartParams, "experimentalRawEvents" | "persistExtendedHistory">): Promise<ThreadStartResponse> {
    return this.request<ThreadStartResponse>("thread/start", {
      ...params,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    } satisfies ThreadStartParams);
  }

  public async resumeThread(params: Omit<ThreadResumeParams, "persistExtendedHistory">): Promise<ThreadResumeResponse> {
    return this.request<ThreadResumeResponse>("thread/resume", {
      ...params,
      persistExtendedHistory: true,
    } satisfies ThreadResumeParams);
  }

  public async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.request<TurnStartResponse>("turn/start", params);
  }

  public async steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return this.request<TurnSteerResponse>("turn/steer", params);
  }

  public async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return this.request<TurnInterruptResponse>("turn/interrupt", params);
  }

  public async setThreadName(threadId: string, name: string): Promise<ThreadSetNameResponse> {
    return this.request<ThreadSetNameResponse>("thread/name/set", {
      threadId,
      name,
    });
  }

  public async probeModel(options: ModelProbeOptions): Promise<void> {
    const thread = await this.startThread({
      cwd: options.cwd,
      serviceName: options.serviceName,
      model: options.model,
      ephemeral: true,
    });
    const threadId = thread.thread.id;
    let turnId: string | null = null;
    const completed = this.waitForNotification(
      "turn/completed",
      (notification) => notification.params.threadId === threadId && (!turnId || notification.params.turn.id === turnId),
      options.timeoutMs,
    );

    try {
      const turn = await this.startTurn({
        threadId,
        model: options.model,
        input: [{ type: "text", text: "Reply exactly: OK", text_elements: [] }],
      });
      turnId = turn.turn.id;
    } catch (error) {
      completed.catch(() => undefined);
      throw error;
    }

    const notification = await completed;
    if (notification.params.turn.status !== "completed") {
      throw new Error(notification.params.turn.error?.message || `Probe turn failed with status ${notification.params.turn.status}`);
    }
  }

  public async respond(id: RequestId, result: unknown): Promise<void> {
    this.sendRaw({ id, result });
  }

  public async respondError(id: RequestId, message: string, code = -32601): Promise<void> {
    this.sendRaw({ id, error: { code, message } });
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.process) {
      throw new Error("Codex app-server is not running");
    }

    const id = `client-${this.nextRequestId++}`;
    const payload = { method, id, params };

    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.sendRaw(payload);
    });
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      console.error("Failed to parse app-server JSON:", error);
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    if ("method" in parsed && typeof parsed.method === "string") {
      if ("id" in parsed) {
        this.emit("serverRequest", parsed as ServerRequest);
      } else {
        this.emit("notification", parsed as ServerNotification);
      }
      return;
    }

    if ("id" in parsed) {
      this.handleResponse(parsed as JsonRpcSuccess<unknown> | JsonRpcFailure);
    }
  }

  private handleResponse(message: JsonRpcSuccess<unknown> | JsonRpcFailure): void {
    const id = message.id;
    if (typeof id !== "string") {
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);

    if ("error" in message) {
      const detail = message.error?.message || `Codex app-server request failed for ${pending.method}`;
      pending.reject(new Error(detail));
      return;
    }

    pending.resolve(message.result);
  }

  private sendRaw(message: unknown): void {
    if (!this.process) {
      throw new Error("Codex app-server is not running");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private waitForNotification<T extends ServerNotification["method"]>(
    method: T,
    predicate?: (notification: Extract<ServerNotification, { method: T }>) => boolean,
    timeoutMs = 10_000,
  ): Promise<Extract<ServerNotification, { method: T }>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off("notification", onNotification);
        reject(new Error(`Timed out waiting for Codex notification: ${method}`));
      }, timeoutMs);

      const onNotification = (notification: ServerNotification): void => {
        if (notification.method !== method) {
          return;
        }

        const typed = notification as Extract<ServerNotification, { method: T }>;
        if (predicate && !predicate(typed)) {
          return;
        }

        clearTimeout(timeout);
        this.off("notification", onNotification);
        resolve(typed);
      };

      this.on("notification", onNotification);
    });
  }
}
