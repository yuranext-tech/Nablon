// index.js — точка входа для Render (Background Worker или Web Service)
const cron = require('node-cron');
const { bot, dailyCronTick } = require('./bot');

bot.launch();
console.log('Bot started (long polling).');

// Каждый час проверяем всех пользователей и решаем, кому что отправить.
// nextAction() внутри dailyCronTick сам разбирается, кому пора зонд,
// кому вечерний вопрос, кому напоминание — так что можно дергать часто,
// лишние вызовы для пользователей в состоянии ACTIVE/DORMANT просто no-op.
cron.schedule('*/5 * * * *', () => {
  dailyCronTick().catch((err) => console.error('dailyCronTick error:', err));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
