import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import dotenv from "dotenv";

export interface AppConfig {
  readonly configFilePath: string;
  readonly instanceName: string;
  readonly instanceRoot: string;
  readonly dataDir: string;
  readonly telegramFileDir: string;
  readonly logDir: string;
  readonly runDir: string;
  readonly lockPath: string;
  readonly telegramBotToken: string;
  readonly telegramAllowedUserId: number;
  readonly telegramApiBaseUrl: string;
  readonly telegramProxyUrl?: string;
  readonly codexWorkspaceCwd: string;
  readonly codexBin: string;
  readonly codexModel?: string;
  readonly databasePath: string;
  readonly serviceName: string;
  readonly pollTimeoutSeconds: number;
  readonly pollLimit: number;
  readonly progressUpdateIntervalMs: number;
  readonly openaiApiKey?: string;
}

interface CliConfigOptions {
  readonly configFilePath?: string;
  readonly instanceName?: string;
}

type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function loadConfig(argv = process.argv.slice(2), env = process.env): AppConfig {
  const cli = parseCliConfigOptions(argv);
  const configFilePath = resolveConfigFilePath(cli, env);
  const fileEnv = readConfigFile(configFilePath);
  const mergedEnv = createMergedEnv(env, fileEnv);

  const instanceName = cli.instanceName || readOptionalEnv(mergedEnv, "INSTANCE_NAME") || deriveInstanceName(configFilePath);
  const instanceRoot = resolveConfiguredPath(
    readOptionalEnv(mergedEnv, "INSTANCE_ROOT"),
    path.dirname(configFilePath),
    path.dirname(configFilePath),
  );
  const dataDir = resolveConfiguredPath(readOptionalEnv(mergedEnv, "DATA_DIR"), instanceRoot, path.join(instanceRoot, "data"));
  const telegramFileDir = resolveConfiguredPath(
    readOptionalEnv(mergedEnv, "TELEGRAM_FILE_DIR"),
    instanceRoot,
    path.join(dataDir, "tg-files"),
  );
  const logDir = resolveConfiguredPath(readOptionalEnv(mergedEnv, "LOG_DIR"), instanceRoot, path.join(instanceRoot, "logs"));
  const runDir = resolveConfiguredPath(readOptionalEnv(mergedEnv, "RUN_DIR"), instanceRoot, path.join(instanceRoot, "run"));
  const databasePath = resolveConfiguredPath(
    readOptionalEnv(mergedEnv, "DATABASE_PATH"),
    instanceRoot,
    path.join(dataDir, "bridge.db"),
  );
  const serviceName =
    readOptionalEnv(mergedEnv, "SERVICE_NAME") || `codex_tg_bridge_${sanitizeServiceSuffix(instanceName)}`;

  const telegramAllowedUserId = Number.parseInt(
    requiredEnv(mergedEnv, "TELEGRAM_ALLOWED_USER_ID", configFilePath),
    10,
  );
  if (!Number.isSafeInteger(telegramAllowedUserId)) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must be a safe integer");
  }

  const codexWorkspaceValue =
    readOptionalEnv(mergedEnv, "CODEX_WORKSPACE_CWD") ||
    readOptionalEnv(mergedEnv, "CODEX_CWD") ||
    process.cwd();
  const codexWorkspaceCwd = path.resolve(instanceRoot, codexWorkspaceValue);
  const codexBin = readOptionalEnv(mergedEnv, "CODEX_BIN") || "codex";
  const codexModel = readOptionalEnv(mergedEnv, "CODEX_MODEL") || undefined;
  const openaiApiKey = readOptionalEnv(mergedEnv, "OPENAI_API_KEY") || undefined;

  ensureDirectory(instanceRoot);
  ensureDirectory(dataDir);
  ensureDirectory(logDir);
  ensureDirectory(runDir);
  ensureDirectory(codexWorkspaceCwd);

  return {
    configFilePath,
    instanceName,
    instanceRoot,
    dataDir,
    telegramFileDir,
    logDir,
    runDir,
    lockPath: path.join(runDir, "bridge.lock"),
    telegramBotToken: requiredEnv(mergedEnv, "TELEGRAM_BOT_TOKEN", configFilePath),
    telegramAllowedUserId,
    telegramApiBaseUrl: readOptionalEnv(mergedEnv, "TELEGRAM_API_BASE_URL") || "https://api.telegram.org",
    telegramProxyUrl:
      readOptionalEnv(mergedEnv, "TELEGRAM_PROXY_URL") ||
      readOptionalEnv(mergedEnv, "HTTPS_PROXY") ||
      readOptionalEnv(mergedEnv, "HTTP_PROXY") ||
      readOptionalEnv(mergedEnv, "ALL_PROXY") ||
      undefined,
    codexWorkspaceCwd,
    codexBin,
    codexModel,
    databasePath,
    serviceName,
    pollTimeoutSeconds: parsePositiveInteger(mergedEnv, "TG_POLL_TIMEOUT_SECONDS", 30),
    pollLimit: parsePositiveInteger(mergedEnv, "TG_POLL_LIMIT", 20),
    progressUpdateIntervalMs: parsePositiveInteger(mergedEnv, "TG_PROGRESS_UPDATE_INTERVAL_MS", 1500),
    openaiApiKey,
  };
}

function parseCliConfigOptions(argv: string[]): CliConfigOptions {
  let configFilePath: string | undefined;
  let instanceName: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --config");
      }
      configFilePath = path.resolve(expandHomeDirectory(next));
      index += 1;
      continue;
    }

    if (arg === "--instance") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --instance");
      }
      instanceName = next.trim();
      index += 1;
    }
  }

  return {
    configFilePath,
    instanceName,
  };
}

function resolveConfigFilePath(cli: CliConfigOptions, env: EnvSource): string {
  if (cli.configFilePath) {
    return expandHomeDirectory(cli.configFilePath);
  }

  const explicitConfig = readOptionalEnv(env, "CONFIG_FILE");
  if (explicitConfig) {
    return path.resolve(expandHomeDirectory(explicitConfig));
  }

  const instanceName = cli.instanceName || readOptionalEnv(env, "INSTANCE_NAME") || "default";
  const defaultConfigPath = path.join(os.homedir(), ".codex-telegram-bridge", "instances", instanceName, "config.env");
  if (cli.instanceName || fs.existsSync(defaultConfigPath)) {
    return defaultConfigPath;
  }

  const localConfigPath = path.resolve("config.env");
  if (fs.existsSync(localConfigPath)) {
    return localConfigPath;
  }

  const legacyDotenvPath = path.resolve(".env");
  if (fs.existsSync(legacyDotenvPath)) {
    return legacyDotenvPath;
  }

  return defaultConfigPath;
}

function readConfigFile(configFilePath: string): Record<string, string> {
  if (!fs.existsSync(configFilePath)) {
    return {};
  }

  return dotenv.parse(fs.readFileSync(configFilePath, "utf8"));
}

function createMergedEnv(processEnv: EnvSource, fileEnv: Record<string, string>): Record<string, string | undefined> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") {
          return undefined;
        }

        const processValue = processEnv[property];
        if (typeof processValue === "string" && processValue.trim()) {
          return processValue;
        }

        return fileEnv[property];
      },
    },
  ) as Record<string, string | undefined>;
}

function requiredEnv(env: EnvSource, name: string, configFilePath: string): string {
  const value = readOptionalEnv(env, name);
  if (!value) {
    throw new Error(
      `Missing required configuration: ${name}. Set it in the environment or create ${configFilePath} from config.env.example.`,
    );
  }
  return value;
}

function readOptionalEnv(env: EnvSource, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveInteger(env: EnvSource, name: string, fallback: number): number {
  const raw = readOptionalEnv(env, name);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function deriveInstanceName(configFilePath: string): string {
  return path.basename(path.dirname(configFilePath)) || "default";
}

function resolveConfiguredPath(rawValue: string | undefined, baseDir: string, fallback: string): string {
  const value = expandHomeDirectory(rawValue || fallback);
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }

  return path.resolve(baseDir, value);
}

function sanitizeServiceSuffix(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "default";
}

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function expandHomeDirectory(input: string): string {
  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}
