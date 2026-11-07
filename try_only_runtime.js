// Temporary isolated Telegram pilot. No PostgreSQL, migrations, numeric probes or cron.
// Enable only by setting NABLON_RUNTIME_MODE=try-only on the Render service.
// In-memory sessions are intentionally lost when the service restarts.
const { Telegraf } = require('telegraf');
const { TrySceneManager } = require('./try_scene');
const { registerTrySceneHandlers } = require('./try_scene_telegram');
const { createHealthServer } = require('./health');

async function main() {
  if (process.env.NABLON_RUNTIME_MODE !== 'try-only') {
    throw new Error('Standalone /try runtime requires explicit NABLON_RUNTIME_MODE=try-only');
  }
  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN is required');
  }
  const bot = new Telegraf(process.env.BOT_TOKEN);
  registerTrySceneHandlers(bot, new TrySceneManager());
  bot.start(async (ctx) => {
    await ctx.reply('Это временная проверка Nablon. Сейчас доступна только команда /try. Старый цикл прогнозов отключён.');
  });
  bot.catch((err) => console.error('try-only Telegram handler error:', err.message));
  const server = createHealthServer();
  const port = process.env.PORT || 3000;
  await new Promise((resolve) => server.listen(port, resolve));
  console.log('Try-only health server listening on port', port);
  try {
    // Do not drop pending Telegram messages; the old mode is intentionally disabled.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    await bot.launch();
    console.log('Try-only Telegram polling started');
  } catch (err) {
    console.error('Try-only Telegram startup failed:', err.message);
    server.close();
    process.exitCode = 1;
    return;
  }
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Try-only fatal startup:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
