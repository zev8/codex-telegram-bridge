import { CodexAppServerClient } from "./codex-app-server";
import { selectCodexModel } from "./codex-model";
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

  const selection = await selectCodexModel(codex, config);
  console.log(`Codex models OK: ${selection.visibleModelCount} model(s) visible`);
  for (const failure of selection.failures) {
    console.warn(`Codex model probe failed for ${failure.model}: ${failure.error}`);
  }
  console.log(`Codex model probe OK: ${selection.model}`);

  await codex.close();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
