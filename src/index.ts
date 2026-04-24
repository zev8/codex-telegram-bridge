import fs from "node:fs";
import path from "node:path";

import { CodexAppServerClient } from "./codex-app-server";
import { BridgeService } from "./bridge-service";
import { loadConfig } from "./config";
import { BridgeDatabase } from "./db";
import { TelegramClient } from "./telegram";

async function main(): Promise<void> {
  const config = loadConfig();
  const releaseLock = acquireProcessLock(config.lockPath);
  try {
    const db = new BridgeDatabase(config.databasePath);
    const telegram = new TelegramClient(config.telegramBotToken, {
      apiBaseUrl: config.telegramApiBaseUrl,
      proxyUrl: config.telegramProxyUrl,
    });
    const codex = new CodexAppServerClient({
      codexBin: config.codexBin,
      openaiApiKey: config.openaiApiKey,
    });
    const service = new BridgeService(config, db, telegram, codex);
    let shutdownPromise: Promise<void> | null = null;
    let runPromise: Promise<void> | null = null;

    const shutdown = async (): Promise<void> => {
      if (shutdownPromise) {
        await shutdownPromise;
        return;
      }

      shutdownPromise = (async () => {
        service.stop();
      })();

      await shutdownPromise;
    };

    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });

    process.on("exit", () => {
      releaseLock();
    });

    runPromise = service.start();
    try {
      await runPromise;
    } finally {
      await codex.close();
      db.close();
    }
  } finally {
    releaseLock();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function acquireProcessLock(lockPath: string): () => void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
      fs.closeSync(fd);

      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const stalePid = readLockPid(lockPath);
      if (stalePid !== null && isProcessAlive(stalePid)) {
        throw new Error(`Another bridge instance is already running (pid ${stalePid}).`);
      }

      fs.rmSync(lockPath, { force: true });
    }
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}
