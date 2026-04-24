import fs from "node:fs/promises";
import path from "node:path";

import { ProxyAgent, type Dispatcher } from "undici";

export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly username?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly date: number;
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: TelegramPhotoSize[];
  readonly document?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly data?: string;
  readonly message?: TelegramMessage;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

export interface TelegramInlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

export interface TelegramDocument {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

export interface TelegramFile {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_size?: number;
  readonly file_path?: string;
}

export interface TelegramReplyMarkup {
  readonly inline_keyboard: TelegramInlineKeyboardButton[][];
}

interface TelegramApiEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
}

export class TelegramApiError extends Error {
  public readonly errorCode?: number;

  public constructor(message: string, errorCode?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.errorCode = errorCode;
  }
}

export interface TelegramSendMessageOptions {
  readonly replyMarkup?: TelegramReplyMarkup;
  readonly replyToMessageId?: number;
}

export interface TelegramSendMediaOptions {
  readonly caption?: string;
  readonly replyToMessageId?: number;
}

export class TelegramClient {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;
  private readonly dispatcher?: Dispatcher;

  public constructor(token: string, options?: { readonly apiBaseUrl?: string; readonly proxyUrl?: string }) {
    const apiBaseUrl = options?.apiBaseUrl || "https://api.telegram.org";
    const normalizedBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.baseUrl = `${normalizedBaseUrl}/bot${token}`;
    this.fileBaseUrl = `${normalizedBaseUrl}/file/bot${token}`;
    this.dispatcher = options?.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  }

  public async getMe(): Promise<TelegramUser> {
    return this.callApi<TelegramUser>("getMe", {});
  }

  public async getUpdates(params: {
    readonly offset?: number;
    readonly timeout: number;
    readonly limit: number;
  }): Promise<TelegramUpdate[]> {
    return this.callApi<TelegramUpdate[]>("getUpdates", params);
  }

  public async setMyCommands(commands: Array<{ readonly command: string; readonly description: string }>): Promise<void> {
    await this.callApi("setMyCommands", { commands });
  }

  public async getFile(fileId: string): Promise<TelegramFile> {
    return this.callApi<TelegramFile>("getFile", { file_id: fileId });
  }

  public async sendChatAction(chatId: number, action: string): Promise<void> {
    await this.callApi("sendChatAction", { chat_id: chatId, action });
  }

  public async sendMessage(
    chatId: number,
    text: string,
    options: TelegramSendMessageOptions = {},
  ): Promise<TelegramMessage> {
    return this.callApi<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: options.replyMarkup,
      reply_to_message_id: options.replyToMessageId,
    });
  }

  public async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: { readonly replyMarkup?: TelegramReplyMarkup } = {},
  ): Promise<TelegramMessage | true> {
    try {
      return await this.callApi<TelegramMessage | true>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: options.replyMarkup,
      });
    } catch (error) {
      if (error instanceof TelegramApiError && error.message.includes("message is not modified")) {
        return true;
      }
      throw error;
    }
  }

  public async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.callApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  public async sendLongMessage(
    chatId: number,
    text: string,
    options: TelegramSendMessageOptions = {},
  ): Promise<TelegramMessage[]> {
    const parts = splitTelegramText(text);
    const messages: TelegramMessage[] = [];

    for (const [index, part] of parts.entries()) {
      messages.push(
        await this.sendMessage(chatId, part, {
          replyMarkup: index === 0 ? options.replyMarkup : undefined,
          replyToMessageId: index === 0 ? options.replyToMessageId : undefined,
        }),
      );
    }

    return messages;
  }

  public async downloadFileToPath(filePath: string, destinationPath: string): Promise<void> {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    const response = await fetch(`${this.fileBaseUrl}/${filePath.replace(/^\/+/, "")}`, {
      method: "GET",
      dispatcher: this.dispatcher,
    } as RequestInit & { dispatcher?: Dispatcher });

    if (!response.ok) {
      throw new TelegramApiError(`Telegram file download failed: ${response.status} ${response.statusText}`, response.status);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destinationPath, bytes);
  }

  public async sendPhoto(
    chatId: number,
    photoPath: string,
    options: TelegramSendMediaOptions = {},
  ): Promise<TelegramMessage> {
    return this.callApiMultipart<TelegramMessage>("sendPhoto", "photo", photoPath, {
      chat_id: String(chatId),
      caption: options.caption,
      reply_to_message_id:
        options.replyToMessageId === undefined ? undefined : String(options.replyToMessageId),
    });
  }

  public async sendDocument(
    chatId: number,
    documentPath: string,
    options: TelegramSendMediaOptions = {},
  ): Promise<TelegramMessage> {
    return this.callApiMultipart<TelegramMessage>("sendDocument", "document", documentPath, {
      chat_id: String(chatId),
      caption: options.caption,
      reply_to_message_id:
        options.replyToMessageId === undefined ? undefined : String(options.replyToMessageId),
    });
  }

  public async sendLocalImage(
    chatId: number,
    imagePath: string,
    options: TelegramSendMediaOptions = {},
  ): Promise<TelegramMessage> {
    const extension = path.extname(imagePath).toLowerCase();
    if (PREFER_DOCUMENT_EXTENSIONS.has(extension)) {
      return this.sendDocument(chatId, imagePath, options);
    }

    try {
      return await this.sendPhoto(chatId, imagePath, options);
    } catch (error) {
      if (error instanceof TelegramApiError) {
        return this.sendDocument(chatId, imagePath, options);
      }
      throw error;
    }
  }

  private async callApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      dispatcher: this.dispatcher,
    } as RequestInit & { dispatcher?: Dispatcher });

    return this.parseApiResponse<T>(method, response);
  }

  private async callApiMultipart<T>(
    method: string,
    fileField: string,
    filePath: string,
    fields: Record<string, string | undefined>,
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== "") {
        form.set(key, value);
      }
    }

    const bytes = await fs.readFile(filePath);
    form.set(fileField, new Blob([bytes]), path.basename(filePath));

    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      body: form,
      dispatcher: this.dispatcher,
    } as RequestInit & { dispatcher?: Dispatcher });

    return this.parseApiResponse<T>(method, response);
  }

  private async parseApiResponse<T>(method: string, response: Response): Promise<T> {
    const data = (await response.json()) as TelegramApiEnvelope<T>;
    if (!response.ok || !data.ok || data.result === undefined) {
      throw new TelegramApiError(data.description || `Telegram API call failed for ${method}`, data.error_code);
    }

    return data.result;
  }
}

const PREFER_DOCUMENT_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".ico",
  ".svg",
  ".svgz",
  ".tif",
  ".tiff",
  ".webp",
]);

export function splitTelegramText(input: string, maxLength = 3900): string[] {
  const text = input.trim();
  if (!text) {
    return ["(empty response)"];
  }

  if (text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const splitAt =
      slice.lastIndexOf("\n\n") > maxLength * 0.5
        ? slice.lastIndexOf("\n\n") + 2
        : slice.lastIndexOf("\n") > maxLength * 0.5
          ? slice.lastIndexOf("\n") + 1
          : slice.lastIndexOf(" ") > maxLength * 0.5
            ? slice.lastIndexOf(" ") + 1
            : maxLength;

    const chunk = remaining.slice(0, splitAt).trim();
    parts.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}
