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
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  })
  .listen(PORT, () => console.log(`Health-check server on port ${PORT}`));

async function main() {
  await runMigration(); // применяет schema.sql — локальный SQL-клиент не нужен

  bot.launch();
  console.log('Bot started (long polling).');

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
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
