import { loadConfig } from "./config";
import { TelegramClient } from "./telegram";

async function main(): Promise<void> {
  const config = loadConfig();
  const telegram = new TelegramClient(config.telegramBotToken, {
    apiBaseUrl: config.telegramApiBaseUrl,
    proxyUrl: config.telegramProxyUrl,
  });

  const me = await telegram.getMe();
  console.log(`Telegram bot OK: @${me.username || me.first_name} (${me.id})`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
