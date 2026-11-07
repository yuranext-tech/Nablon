// Telegram glue for the standalone /try scene. Kept separate from database handlers
// so that interaction (including Telegram failures) can be tested without a bot token.
function inlineKeyboard(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

function registerTrySceneHandlers(bot, scenes) {
  bot.command('try', async (ctx) => {
    const scene = scenes.start(ctx.from.id);
    await ctx.reply(scene.message, inlineKeyboard(scene.buttons));
  });

  bot.on('callback_query', async (ctx) => {
    const callback = ctx.callbackQuery || {};
    const result = scenes.handle(ctx.from.id, callback.data, callback.id);
    if (!result.handled) return;

    try {
      await ctx.answerCbQuery(result.status === 'APPLIED' ? undefined : result.message, {
        show_alert: result.status !== 'APPLIED',
      });
    } catch (err) {
      // Telegram callback acknowledgement may fail after the scene was advanced.
      // Still attempt to display the accepted outcome.
      console.error('try callback acknowledgement failed:', err.message);
    }

    if (result.status !== 'APPLIED') return;
    try {
      await ctx.editMessageText(result.message, inlineKeyboard(result.buttons));
    } catch (err) {
      console.error('try scene message update failed:', err.message);
      // A deleted/uneditable original message must not leave the user unaware
      // of an already accepted action. Never replay the action to recover UI.
      try {
        await ctx.reply(result.message, inlineKeyboard(result.buttons));
      } catch (replyError) {
        console.error('try scene fallback reply failed:', replyError.message);
      }
    }
  });
}

module.exports = { registerTrySceneHandlers };
