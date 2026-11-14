// Isolated Telegram pilot. The orientation option uses its own R1 store.
// Enable only by setting NABLON_RUNTIME_MODE=try-only on the Render service.
// The fallback scene is in-memory; orientation sessions persist in their own database.
const { Telegraf } = require('telegraf');
const { TrySceneManager } = require('./try_scene');
const { registerTrySceneHandlers } = require('./try_scene_telegram');
const { createHealthServer } = require('./health');
const { ensureOrientationSchema } = require('./orientation/ensure_schema');
const { installPollingWatchdog } = require('./orientation/polling_watchdog');

async function main() {
  if (process.env.NABLON_RUNTIME_MODE !== 'try-only') {
    throw new Error('Standalone /try runtime requires explicit NABLON_RUNTIME_MODE=try-only');
  }
  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN is required');
  }
  const bot = new Telegraf(process.env.BOT_TOKEN);
  bot.use(async (ctx, next) => {
    console.log('Try-only incoming Telegram update:', ctx.updateType);
    return next();
  });
  const orientationPool = process.env.NABLON_TRY_EPISODE === 'last-copy-v1'
    ? require('./orientation/telegram').registerConfiguredOrientation(bot, process.env)
    : null;
  if (orientationPool) {
    try {
      await ensureOrientationSchema(orientationPool);
      console.log('Orientation database schema ready');
    } catch (error) {
      await orientationPool.end().catch(() => {});
      throw error;
    }
  } else {
    registerTrySceneHandlers(bot, new TrySceneManager());
  }
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
    const identity = await bot.telegram.getMe();
    console.log('Try-only Telegram identity:', '@' + identity.username);
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    console.log('Try-only Telegram polling requested');
    // Telegraf launch() runs the polling loop until shutdown, so awaiting it
    // would suppress the success log for the entire life of a healthy bot.
    let stopping = false;
    const watchdog = installPollingWatchdog(bot, {
      onStall: ({ elapsedMs, observedSuccess }) => {
        console.error('Try-only Telegram getUpdates stalled:', elapsedMs, 'ms; successful poll observed:', observedSuccess);
        // A live HTTP server is not evidence that Telegram polling is alive.
        // Exit with failure so the hosting platform can restart the entire process.
        process.exit(1);
      },
    });
    let retryTimer = null;
    let attempts = 0;
    function launchPolling() {
      if (stopping) return;
      attempts += 1;
      watchdog.reset();
      console.log('Try-only Telegram polling attempt', attempts);
      bot.launch().then(() => {
        if (!stopping) console.error('Try-only Telegram polling stopped unexpectedly');
      }).catch((err) => {
        console.error('Try-only Telegram polling failed:', err.message);
        if (!stopping) retryTimer = setTimeout(launchPolling, 15000);
      });
    }
    launchPolling();
    function stop(signal) {
      stopping = true;
      clearTimeout(retryTimer);
      watchdog.stop();
      server.close();
      bot.stop(signal);
      if (orientationPool) orientationPool.end().catch(() => {});
    }
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  } catch (err) {
    console.error('Try-only Telegram startup failed:', err.message);
    server.close();
    if (orientationPool) await orientationPool.end();
    process.exitCode = 1;
    return;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Try-only fatal startup:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
