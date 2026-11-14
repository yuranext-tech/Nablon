const { createHmac } = require('node:crypto');
const { Pool } = require('pg');
const { createRepository } = require('./repository');
const { screen } = require('./episode');

function registerOrientation(bot, repository, secret) {
  const owner = (ctx) => createHmac('sha256', secret).update(String(ctx.from.id)).digest('hex');
  const available = (ctx) => ctx.chat?.type === 'private' && ctx.from && Number.isSafeInteger(ctx.update?.update_id);
  const options = (view) => ({ reply_markup: { inline_keyboard: view.buttons } });

  async function handle(ctx, request, callback = false) {
    if (!available(ctx)) return;
    const subject = owner(ctx);
    const commandId = String(ctx.update.update_id);
    let result;
    try {
      result = await repository.execute(subject, commandId, request);
    } catch {
      await ctx.reply('Не удалось подтвердить ход. Нажми ту же кнопку ещё раз или открой /try.');
      return;
    }
    if (callback) await ctx.answerCbQuery().catch(() => {});
    const episode = result.presentation ?? result.episode;
    if (!episode) {
      await ctx.reply('Этот ход больше недоступен. Открой /try, чтобы продолжить.');
      return;
    }
    const view = screen(episode, episode.state.helpPending);
    const markup = options(view);
    let method;
    if (callback) {
      try {
        await ctx.editMessageText(view.message, markup);
        method = 'edit';
      } catch { /* Try a new message if editing did not succeed. */ }
    }
    if (!method) {
      try {
        await ctx.reply(view.message, markup);
        method = 'reply';
      } catch {
        // The committed result is still available through /try or a button retry.
        console.error('orientation: Telegram presentation failed');
        return;
      }
    }
    try {
      await repository.recordSent(subject, episode, commandId, method);
    } catch {
      // A failure to record an acknowledgement must not trigger another send.
      console.error('orientation: could not record Telegram acknowledgement');
    }
  }

  bot.command('try', (ctx) => handle(ctx, { action: 'start' }));
  bot.command('try_again', (ctx) => handle(ctx, { action: 'restart' }));
  bot.command('help', (ctx) => handle(ctx, { action: 'help' }));
  bot.on('callback_query', (ctx) => {
    const match = /^o1:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):([1-9][0-9]{0,8}):(open|old|latest|finish)$/.exec(ctx.callbackQuery?.data ?? '');
    if (!match) return;
    return handle(ctx, { action: match[3], episodeId: match[1], version: Number(match[2]) }, true);
  });
}

function registerConfiguredOrientation(bot, env) {
  if (!env.NABLON_ORIENTATION_DATABASE_URL || !env.NABLON_ORIENTATION_SUBJECT_KEY) {
    throw new Error('Orientation requires NABLON_ORIENTATION_DATABASE_URL and NABLON_ORIENTATION_SUBJECT_KEY');
  }
  const pool = new Pool({ connectionString: env.NABLON_ORIENTATION_DATABASE_URL });
  registerOrientation(bot, createRepository(pool), env.NABLON_ORIENTATION_SUBJECT_KEY);
  return pool;
}

module.exports = { registerOrientation, registerConfiguredOrientation };
