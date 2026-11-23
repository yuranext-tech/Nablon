'use strict';

const { registerS3Telegram } = require('./s3-telegram');
const { createOutboxSender } = require('../nablon/runtime/outbox');
const { randomUUID, createHash } = require('node:crypto');
const engine = require('./engine');
const { scenarios, consequences } = require('./content');
const { createS3Repository } = require('./s3-postgres');
const { previewTranslations, displayText } = require('./personal-preview-i18n');

const TRAINING = 'NABLON_PERSONAL_PREVIEW';

function syntheticS2Entry() {
  // S1 is a deterministic bootstrap fixture, NOT evidence of real activity.
  // S2 starts with exposure unknown, and stays unknown throughout preview.
  const state = engine.create();
  engine.selectInterest(state, 'unknown');
  engine.presentation(state, 'scenario', 'confirmed');
  engine.act(state, 'add');
  engine.next(state);
  state.previewOnly = true;
  if (state.current?.id !== 'S2' || state.current.delivery !== 'unknown')
    throw new Error('Preview bootstrap failed');
  return state;
}

function entryEpisodeId(sessionId) {
  const h = createHash('sha256').update('private-preview:' + sessionId).digest('hex');
  return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);
}

// Only for a DEDICATED preview database. Restart uses the same durable session.
function createPreviewEntryProvider(pool) {
  return async ownerTelegramId => {
    const client = await pool.connect();
    let entry;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['personal-preview:' + ownerTelegramId]);
      const found = await client.query(
        'INSERT INTO users(telegram_id) VALUES($1) ON CONFLICT(telegram_id) '+
        'DO UPDATE SET last_active_at=NOW() RETURNING id', [ownerTelegramId]);
      const userId = found.rows[0].id;
      const sessions = await client.query(
        "SELECT id, training_id FROM nablon_sessions WHERE user_id=$1 AND status='ACTIVE' FOR UPDATE",
        [userId]);
      let sessionId;
      if (sessions.rows.length) {
        if (sessions.rows[0].training_id !== TRAINING)
          throw new Error('Active non-preview session in preview database');
        sessionId = sessions.rows[0].id;
      } else {
        const number = await client.query(
          'SELECT COALESCE(MAX(session_number),0)+1 AS n FROM nablon_sessions WHERE user_id=$1',
          [userId]);
        sessionId = randomUUID();
        await client.query(
          "INSERT INTO nablon_sessions(id,user_id,session_number,mode,training_id,status)"+
          " VALUES($1,$2,$3,'demo',$4,'ACTIVE')",
          [sessionId,userId,number.rows[0].n,TRAINING]);
      }
      entry = { context: { userId, sessionId, episodeId: entryEpisodeId(sessionId) },
        state: syntheticS2Entry(), commandId: 'preview-open:' + sessionId };
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
    return entry;
  };
}

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
  // One-owner session: Ukrainian is always the process default.
  // Russian requires an explicit user action. Language changes are preview-only
  // and ephemeral; reopening the program restores the Ukrainian default.
  let language = 'uk';
  const t = () => previewTranslations(language);
  const label = action => t().buttons[action] ?? action;
  const localize = (kind, key, original) => displayText(language, kind, key, original);
  const languageRow = () => [{ text: t().languageButton, callback_data: 'preview:language' }];
  const repo = createS3Repository(pool);

  // A language change re-renders the already committed scene, without
  // generating a new action, confirmation, or canonical evidence event.
  async function showCurrentScene(ctx) {
    const result = await pool.query(
      `SELECT s.id AS session_id, s.user_id, s.current_episode_id
       FROM nablon_sessions s JOIN users u ON u.id=s.user_id
       WHERE u.telegram_id=$1 AND s.status='ACTIVE' AND s.training_id=$2`,
      [ownerTelegramId, TRAINING],
    );
    const session = result.rows[0];
    if (!session?.current_episode_id) return ctx.reply(t().noSession);
    const context = { userId: session.user_id, sessionId: session.session_id,
      episodeId: session.current_episode_id };
    const source = await repo.readSource(context);
    if (!source) return ctx.reply(t().noSession);
    const episode = source.state.current;
    const lastConsequence = [...source.events].reverse()
      .find(event => event.type === 'CONSEQUENCE_PREPARED');
    const sourceKind = lastConsequence ? 'consequences' : 'scenarios';
    const sourceKey = lastConsequence?.consequence ?? episode.id;
    const original = lastConsequence ? consequences[sourceKey] : scenarios[sourceKey];
    if (!original) throw new Error('Preview translation reference not found');
    let choices = [];
    if (episode.id === 'S2' && !episode.done) choices = engine.ACTIONS.S2;
    if (episode.id === 'S3') choices = episode.done ? ['S4A', 'S4B'] : engine.ACTIONS.S3;
    const keyboard = choices.length ? [choices.map(action => ({
      text: label(action),
      callback_data: `${episode.id.toLowerCase()}:${context.episodeId}:${episode.turns}:${action}`,
    }))] : [];
    keyboard.push(languageRow());
    return ctx.reply(localize(sourceKind, sourceKey, original),
      { reply_markup: { inline_keyboard: keyboard } });
  }
  const chooseLanguage = ctx => ctx.reply(t().chooseLanguage,
    { reply_markup: { inline_keyboard: [[
      { text: '🇺🇦 Українська', callback_data: 'preview:language:uk' },
      { text: '🇷🇺 Русский', callback_data: 'preview:language:ru' },
    ]] } });

  const flushOutbox = createOutboxSender(pool, {
    async sendMessage(chatId, ...args) {
      if (String(chatId) !== String(ownerTelegramId)) throw new Error('Preview recipient mismatch');
      return bot.telegram.sendMessage(chatId, ...args);
    },
  });
  const { openS2 } = registerS3Telegram(bot, {
    pool, flushOutbox, buttonLabels: label, previewAllowUnknownS2: true,
    displayText: localize, languageButton: () => t().languageButton,
  });

  bot.command('language', chooseLanguage);
  bot.action('preview:language', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    await chooseLanguage(ctx);
  });
  bot.action(/^preview:language:(uk|ru)$/, async ctx => {
    language = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    await showCurrentScene(ctx);
  });

  bot.start(async (ctx) => {
    // Only a server-side entry provider can supply the existing S2 prerequisite.
    // Telegram updates and successful sends cannot provide this state.
    const entry = await loadS2Entry(ownerTelegramId);
    if (entry?.state?.current?.id !== 'S2' || entry.state.current.delivery !== 'unknown' ||
        entry.state.previewOnly !== true) {
      return ctx.reply(START_UNAVAILABLE);
    }
    const { context, state, commandId } = entry;
    const owner = await pool.query('SELECT 1 FROM users WHERE id=$1 AND telegram_id=$2',
      [context.userId, ownerTelegramId]);
    if (owner.rowCount !== 1) return ctx.reply(START_UNAVAILABLE);
    await openS2(context, state, commandId);
  });
  return { flushOutbox };
}

module.exports = { registerPersonalPreview, createPreviewEntryProvider, syntheticS2Entry, TRAINING };
