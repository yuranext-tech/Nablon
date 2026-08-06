// index.js — точка входа для Render (Background Worker)
const cron = require('node-cron');
const { runMigration } = require('./migrate');
const { bot, dailyCronTick } = require('./bot');

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

