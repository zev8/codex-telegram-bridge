import { TelegramClient } from "./telegram";

export class ProgressMessage {
  private messageId: number | null = null;
  private lastText = "";
  private pendingText = "";
  private lastFlushAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly telegram: TelegramClient,
    private readonly chatId: number,
    private readonly intervalMs: number,
    private readonly replyToMessageId?: number,
  ) {}

  public getMessageId(): number | null {
    return this.messageId;
  }

  public update(text: string): void {
    const normalized = normalizeProgressText(text);
    if (!normalized) {
      return;
    }

    this.pendingText = normalized;
    this.scheduleFlush();
  }

  public flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    return this.enqueueFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }

    const delay = this.messageId === null ? 0 : Math.max(0, this.intervalMs - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.enqueueFlush();
    }, delay);
  }

  private enqueueFlush(): Promise<void> {
    this.chain = this.chain
      .catch(() => undefined)
      .then(async () => {
        const nextText = this.pendingText;
        if (!nextText || nextText === this.lastText) {
          return;
        }

        if (this.messageId === null) {
          const message = await this.telegram.sendMessage(this.chatId, nextText, {
            replyToMessageId: this.replyToMessageId,
          });
          this.messageId = message.message_id;
        } else {
          await this.telegram.editMessageText(this.chatId, this.messageId, nextText);
        }

        this.lastText = nextText;
        this.lastFlushAt = Date.now();
      })
      .catch((error) => {
        console.error("Failed to update Telegram progress message:", error);
      });

    return this.chain;
  }
}

function normalizeProgressText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= 3800) {
    return trimmed;
  }

  return `${trimmed.slice(0, 3796)} ...`;
}
