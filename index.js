// Explicit runtime selection. The isolated pilot must never import bot.js,
// migrate.js or node-cron, because those belong to the legacy database-backed mode.
if (process.env.NABLON_RUNTIME_MODE === 'try-only') {
  require('./try_only_runtime').main().catch((err) => {
    console.error('Try-only fatal startup:', err.message);
    process.exitCode = 1;
  });
} else {
  // index.js — точка входа для Render (Web Service, бесплатный тариф)
  const cron = require('node-cron');
  const { runMigration } = require('./migrate');
  const { bot, dailyCronTick } = require('./bot');
  const { createHealthServer } = require('./health');
  
  // Render Web Service (free tier) требует слушать порт и засыпает без обращений
  // раз в ~15 минут. Health-check эндпоинт + внешний пинг (UptimeRobot) держат
  // процесс живым бесплатно — тот же приём, что уже применялся в Impact.
  //
  const PORT = process.env.PORT || 3000;
  createHealthServer().listen(PORT, () => console.log(`Health-check server on port ${PORT}`));
  
  async function main() {
    await runMigration(); // применяет schema.sql — локальный SQL-клиент не нужен
  
    // На случай, если на боте случайно включён webhook (конфликтует с long polling
    // и даёт ровно 409 Conflict) — явно снимаем его и сбрасываем зависшую очередь.
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      console.error('deleteWebhook failed (non-fatal):', err.message);
    }
  
    // launch() раньше падал необработанной ошибкой и убивал весь процесс при
    // любом 409 — из-за этого один конфликт приводил к бесконечному циклу
    // перезапусков. Теперь ошибка логируется и попытка повторяется через 15с,
    // а не роняет health-check сервер и не оставляет бота молчащим навсегда.
    function launchWithRetry() {
      bot.launch().catch((err) => {
        console.error('bot.launch() failed:', err.message, '— retry in 15s');
        setTimeout(launchWithRetry, 15000);
      });
    }
    launchWithRetry();
    console.log('Bot launch attempted (long polling).');
  
    cron.schedule('*/5 * * * *', () => {
      dailyCronTick().catch((err) => console.error('dailyCronTick error:', err));
    });
  }
  
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
  
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  
}
