'use strict';

const { registerS3Telegram } = require('./s3-telegram');
const { createOutboxSender } = require('../nablon/runtime/outbox');

// Draft copy for the private walkthrough. Protocol commands stay unchanged.
const BUTTON_LABELS = Object.freeze({
  copy: 'Скопировать карточку',
  settings: 'Открыть настройки',
  check: 'Проверить сохранение',
  delete: 'Удалить старый черновик',
  S4A: 'Задача про календарь',
  S4B: 'Задача про старую карточку',
});

const START_UNAVAILABLE = 'Предпросмотр пока не готов к началу.';

function registerPersonalPreview(bot, { pool, ownerTelegramId, loadS2Entry = async () => null }) {
  if (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0) {
    throw new TypeError('A private preview requires one Telegram owner ID');
  }
  bot.use((ctx, next) => {
    if (ctx.chat?.type === 'private' && ctx.chat.id === ownerTelegramId && ctx.from?.id === ownerTelegramId) {
      return next();
    }
  });
  const flushOutbox = createOutboxSender(pool, {
    async sendMessage(chatId, ...args) {
      if (String(chatId) !== String(ownerTelegramId)) throw new Error('Preview recipient mismatch');
      return bot.telegram.sendMessage(chatId, ...args);
    },
  });
  const { openS2 } = registerS3Telegram(bot, { pool, flushOutbox, buttonLabels: BUTTON_LABELS });

  bot.start(async (ctx) => {
    // Only a server-side entry provider can supply the existing S2 prerequisite.
    // Telegram updates and successful sends cannot provide this state.
    const entry = await loadS2Entry(ownerTelegramId);
    if (entry?.state?.current?.id !== 'S2' || entry.state.current.delivery !== 'confirmed') {
      return ctx.reply(START_UNAVAILABLE);
    }
    const { context, state, commandId } = entry;
    const owner = await pool.query('SELECT 1 FROM users WHERE id=$1 AND telegram_id=$2',
      [context.userId, ownerTelegramId]);
    if (owner.rowCount !== 1) return ctx.reply(START_UNAVAILABLE);
    await openS2(context, state, commandId);
  });
}

module.exports = { registerPersonalPreview };
