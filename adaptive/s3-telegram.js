'use strict';

const { ACTIONS } = require('./engine');
const { scenarios, consequences } = require('./content');
const { createS3Repository } = require('./s3-postgres');
const { enqueueOutbox } = require('../nablon/runtime/outbox');

const callback = /^(s2|s3):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):([0-5]):(copy|settings|check|delete|S4A|S4B)$/;
const branches = ['S4A', 'S4B'];

function registerS3Telegram(bot, { pool, flushOutbox, writeEvent }) {
  const repository = createS3Repository(pool, { writeEvent, prepareReply });

  async function prepareReply(client, context, episode, events) {
    const destination = events.find(event => event.type === 'CONSEQUENCE_PREPARED' || event.type === 'EPISODE_OPENED');
    if (!destination) return;
    const opening = destination.type === 'EPISODE_OPENED';
    const { userId, sessionId, episodeId } = context;
    const { rows: [user] } = await client.query('SELECT id, telegram_id FROM users WHERE id=$1', [userId]);
    const text = opening ? scenarios[episode.id] : consequences[destination.consequence];
    if (!text) throw new Error('Scene reply text is missing');
    let choices = [];
    if (episode.id === 'S2' && !episode.done) choices = ACTIONS.S2;
    if (episode.id === 'S3') choices = episode.done ? branches : ACTIONS.S3;
    const buttons = choices.map(action => ({
      text: action, callback_data: `${episode.id.toLowerCase()}:${episodeId}:${episode.turns}:${action}`,
    }));
    await enqueueOutbox(client, {
      user, session: { id: sessionId }, episode: { id: episodeId },
      logicalKey: `s3:${destination.eventId}`, text,
      replyMarkup: buttons.length ? { inline_keyboard: [buttons] } : null,
    });
  }

  async function sendCommitted(result, episodeId) {
    if (result.status !== 'APPLIED' && result.status !== 'REPLAYED') return;
    await flushOutbox(20, episodeId);
    const transition = result.canonicalEvents.find(event => event.nextEpisodeId);
    if (transition) await flushOutbox(20, transition.nextEpisodeId);
  }

  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (typeof data !== 'string' || (!data.startsWith('s2:') && !data.startsWith('s3:'))) return next();
    const match = callback.exec(data);
    if (!match || ctx.chat?.type !== 'private' || !Number.isSafeInteger(ctx.from?.id) ||
        ctx.chat.id !== ctx.from.id || !Number.isSafeInteger(ctx.update?.update_id)) return;
    const [, prefix, episodeId, turn, action] = match;
    const scene = prefix.toUpperCase();
    const selecting = scene === 'S3' && branches.includes(action);
    if (!selecting && !ACTIONS[scene].includes(action)) return;
    const { rows: [session] } = await pool.query(
      `SELECT s.id, s.user_id FROM nablon_sessions s
       JOIN nablon_episodes e ON e.session_id=s.id
       JOIN users u ON u.id=s.user_id
       WHERE e.id=$1 AND e.scene_id=$3 AND s.status='ACTIVE' AND u.telegram_id=$2`,
      [episodeId, ctx.from.id, scene],
    );
    if (!session) return;
    const result = await repository.execute({ episodeId, userId: session.user_id, sessionId: session.id }, {
      commandId: String(ctx.update.update_id), expectedTurn: Number(turn),
      ...(selecting ? { kind: 'branch', branch: action } : { kind: 'action', action }),
    });
    await sendCommitted(result, episodeId);
    await ctx.answerCbQuery().catch(() => {});
  });

  async function openS3(context, state, commandId) {
    const result = await repository.start(context, state, commandId);
    await sendCommitted(result, context.episodeId);
    return result;
  }

  async function openS2(context, state, commandId) {
    // S2 retains its original gate. The caller supplies trusted engine state.
    // A Telegram send acknowledgement never enters that state.
    if (state?.current?.delivery !== 'confirmed') throw new Error('S2 requires confirmed scenario presentation');
    const result = await repository.startS2(context, state, commandId);
    await sendCommitted(result, context.episodeId);
    return result;
  }

  return { openS2, openS3 };
}

module.exports = { registerS3Telegram };
