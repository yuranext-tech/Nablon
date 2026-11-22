'use strict';

const { ACTIONS } = require('./engine');
const { scenarios, consequences } = require('./content');
const { createS3Repository } = require('./s3-postgres');
const { enqueueOutbox } = require('../nablon/runtime/outbox');

const callback = /^s3:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):([0-5]):(copy|check|delete)$/;

function registerS3Telegram(bot, { pool, flushOutbox, writeEvent }) {
  const repository = createS3Repository(pool, { writeEvent, prepareReply });

  async function prepareReply(client, context, episode, events) {
    const destination = events.find(event => event.type === 'CONSEQUENCE_PREPARED' || event.type === 'EPISODE_OPENED');
    if (!destination) return;
    const opening = destination.type === 'EPISODE_OPENED';
    const { userId, sessionId, episodeId } = context;
    if (opening) {
      const assigned = await client.query(
        `UPDATE nablon_sessions s SET current_episode_id=$1
         WHERE s.id=$2 AND s.user_id=$3 AND s.status='ACTIVE'
           AND (s.current_episode_id IS NULL OR EXISTS (
             SELECT 1 FROM nablon_episodes e WHERE e.id=s.current_episode_id
               AND e.session_id=s.id AND e.scene_id='S2' AND e.status='COMPLETED'
           ))`,
        [episodeId, sessionId, userId],
      );
      if (assigned.rowCount !== 1) throw new Error('No active S3 session');
    }
    const { rows: [user] } = await client.query('SELECT id, telegram_id FROM users WHERE id=$1', [userId]);
    const text = opening ? scenarios.S3 : consequences[destination.consequence];
    if (!text) throw new Error('S3 reply text is missing');
    const buttons = episode.done ? [] : ACTIONS.S3.map(action => ({
      text: action, callback_data: `s3:${episodeId}:${episode.turns}:${action}`,
    }));
    await enqueueOutbox(client, {
      user, session: { id: sessionId }, episode: { id: episodeId },
      logicalKey: `s3:${destination.eventId}`, text,
      replyMarkup: buttons.length ? { inline_keyboard: [buttons] } : null,
    });
  }

  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (typeof data !== 'string' || !data.startsWith('s3:')) return next();
    const match = callback.exec(data);
    if (!match || ctx.chat?.type !== 'private' || !Number.isSafeInteger(ctx.from?.id) ||
        ctx.chat.id !== ctx.from.id || !Number.isSafeInteger(ctx.update?.update_id)) return;
    const [, episodeId, turn, action] = match;
    const { rows: [session] } = await pool.query(
      `SELECT s.id, s.user_id FROM nablon_sessions s
       JOIN nablon_episodes e ON e.id=s.current_episode_id AND e.session_id=s.id
       JOIN users u ON u.id=s.user_id
       WHERE e.id=$1 AND e.scene_id='S3' AND s.status='ACTIVE' AND u.telegram_id=$2`,
      [episodeId, ctx.from.id],
    );
    if (!session) return;
    const result = await repository.execute({ episodeId, userId: session.user_id, sessionId: session.id }, {
      commandId: String(ctx.update.update_id), kind: 'action', action, expectedTurn: Number(turn),
    });
    if (result.status === 'APPLIED' || result.status === 'REPLAYED') await flushOutbox(20, episodeId);
    await ctx.answerCbQuery().catch(() => {});
  });

  async function openS3(context, state, commandId) {
    const result = await repository.start(context, state, commandId);
    if (result.status === 'APPLIED' || result.status === 'REPLAYED') await flushOutbox(20, context.episodeId);
    return result;
  }

  return { openS3 };
}

module.exports = { registerS3Telegram };
