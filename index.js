// index.js — точка входа для Render (Web Service, бесплатный тариф)
const http = require('http');
const cron = require('node-cron');
const { runMigration } = require('./migrate');
const { bot, dailyCronTick } = require('./bot');

// Render Web Service (free tier) требует слушать порт и засыпает без обращений
// раз в ~15 минут. Health-check эндпоинт + внешний пинг (UptimeRobot) держат
// процесс живым бесплатно — тот же приём, что уже применялся в Impact.
const PORT = process.env.PORT || 3000;
http
  .createServer(async (req, res) => {
    if (req.url.split('?')[0] === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  })
  .listen(PORT, () => console.log(`Health-check server on port ${PORT}`));

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
