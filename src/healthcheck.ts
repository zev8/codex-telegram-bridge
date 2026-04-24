import { CodexAppServerClient } from "./codex-app-server";
import { loadConfig } from "./config";
import { TelegramClient } from "./telegram";

async function main(): Promise<void> {
  const config = loadConfig();
  const telegram = new TelegramClient(config.telegramBotToken, {
    apiBaseUrl: config.telegramApiBaseUrl,
    proxyUrl: config.telegramProxyUrl,
  });
  const codex = new CodexAppServerClient({
    codexBin: config.codexBin,
    openaiApiKey: config.openaiApiKey,
  });

  const me = await telegram.getMe();
  console.log(`Telegram bot OK: @${me.username || me.first_name} (${me.id})`);

  const init = await codex.start();
  console.log(`Codex app-server OK: ${init.platformOs} / ${init.userAgent}`);

  const account = await codex.ensureAuthenticated();
  if (account.account) {
    console.log(`Codex auth OK: ${account.account.type}`);
  } else if (!account.requiresOpenaiAuth) {
    console.log("Codex auth OK: no OpenAI auth required in current provider mode");
  } else {
    throw new Error("Codex auth is missing");
  }

  const models = await codex.listModels();
  console.log(`Codex models OK: ${models.data.length} model(s) visible`);
  if (config.codexModel) {
    if (!models.data.some((model) => model.model === config.codexModel)) {
      throw new Error(`Configured CODEX_MODEL is not visible to Codex: ${config.codexModel}`);
    }
    console.log(`Codex model override OK: ${config.codexModel}`);
  }

  await codex.close();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
