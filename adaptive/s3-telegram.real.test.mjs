import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');
const { registerS3Telegram } = require('./s3-telegram');
const { registerPersonalPreview, syntheticS2Entry, createPreviewEntryProvider } = require('./personal-preview');
const { createS3Repository, RECEIPT_NAME } = require('./s3-postgres');
const { intakePacket } = require('./s3-source');
const { createOutboxSender } = require('../nablon/runtime/outbox');
const { recordL0Event } = require('../nablon/runtime/l0-events');
const E = require('./engine');
const C = require('./content');
const { createIntake } = await import(pathToFileURL(process.env.EG_INTAKE_PATH));
const connectionString = process.env.EG_S3_TEST_DATABASE_URL;
if (!connectionString || new URL(connectionString).hostname !== '127.0.0.1') {
  throw new Error('A disposable local PostgreSQL cluster is required');
}
const admin = new Pool({ connectionString });
const schema = 'eg_s3_tg_' + randomUUID().replaceAll('-', '');
let pool;
let schemaCreated = false;
let telegramId = 2000;

const episodePool = () => new Pool({ connectionString, options: '-c search_path=' + schema });

before(async () => {
  const { rows: [db] } = await admin.query("SELECT current_setting('cluster_name') AS name, version()");
  assert.equal(db.name, 'eg-integration-p1-001');
  console.log(db.version);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  pool = episodePool();
  await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
});
after(async () => {
  try {
    if (pool) await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally { await admin.end(); }
});

function reachS2() {
  const s = E.create();
  E.selectInterest(s, 'unknown');
  E.presentation(s, 'scenario', 'confirmed');
  E.act(s, 'add');
  E.next(s);
  E.presentation(s, 'scenario', 'confirmed');
  return s;
}

function reachS3() {
  const s = reachS2();
  E.act(s, 'copy');
  E.act(s, 'copy');
  E.next(s);
  return s;
}

function transport({ writeEvent, failBeforeDrain, send = async () => {} } = {}) {
  const bot = new Telegraf('12345:test-only');
  bot.botInfo = { id: 12345, is_bot: true, first_name: 'Test', username: 'test_bot' };
  bot.use(async (ctx, next) => {
    ctx.answerCbQuery = async () => {};
    return next();
  });
  const sent = [];
  const flush = createOutboxSender(pool, { sendMessage: async (...args) => {
    await send(...args);
    sent.push(args);
  } });
  const route = registerS3Telegram(bot, { pool, writeEvent, flushOutbox: async (...args) => {
    if (failBeforeDrain?.()) throw new Error('COMMITTED_BEFORE_DRAIN');
    await flush(...args);
  } });
  const legacy = [];
  bot.use(async ctx => {
    const { rowCount } = await pool.query(
      'INSERT INTO nablon_processed_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id',
      [ctx.update.update_id],
    );
    if (rowCount) legacy.push(ctx.update.update_id);
  });
  return { ...route, bot, sent, legacy, flush };
}

async function createSession() {
  const tg = ++telegramId;
  const { rows: [user] } = await pool.query('INSERT INTO users(telegram_id) VALUES($1) RETURNING id', [tg]);
  const context = { userId: user.id, sessionId: randomUUID(), episodeId: randomUUID() };
  await pool.query(`INSERT INTO nablon_sessions(id,user_id,session_number,mode,training_id,status)
    VALUES ($1,$2,1,'demo','EG-S3-TELEGRAM','ACTIVE')`, [context.sessionId, user.id]);
  return { context, tg, repository: createS3Repository(pool) };
}

async function open(runtime, scene = 'S3') {
  const fixture = await createSession();
  const result = scene === 'S2' ? await runtime.openS2(fixture.context, reachS2(), 'server-entry')
    : await runtime.openS3(fixture.context, reachS3(), 'server-entry');
  assert.equal(result.status, 'APPLIED');
  assert.equal(runtime.sent[0][1], C.scenarios[scene]);
  return fixture;
}

function update(runtime, { context, tg }, id, turn, action, from = tg) {
  const data = action === 'legacy' ? 'start_training' : `s3:${context.episodeId}:${turn}:${action}`;
  return press(runtime, id, from, data);
}

function press(runtime, id, from, data) {
  return runtime.bot.handleUpdate({
    update_id: id, callback_query: { id: String(id), from: { id: from, first_name: 'Test' },
      message: { message_id: 1, chat: { id: from, type: 'private' } }, chat_instance: 'test', data },
  });
}

const primary = (fixture) => fixture.repository.readPrimaryEvents(fixture.context);
const actions = async (fixture) => (await primary(fixture)).filter(event => event.type === 'ACTION_ACCEPTED');
const queued = async ({ context }) => (await pool.query(
  'SELECT logical_key, status, attempts FROM nablon_outbox WHERE episode_id=$1 ORDER BY id', [context.episodeId],
)).rows;

test('retry after rollback enters S3 ahead of general update deduplication', async () => {
  let fail = true;
  const runtime = transport({ writeEvent: async (args) => {
    if (fail && args.event_name === RECEIPT_NAME && args.payload.commandId === '101') {
      fail = false;
      throw new Error('BEFORE_COMMIT');
    }
    return recordL0Event(args);
  } });
  runtime.bot.catch(error => { throw error; });
  const fixture = await open(runtime);
  await assert.rejects(update(runtime, fixture, 101, 0, 'copy'), /BEFORE_COMMIT/);
  assert.equal((await actions(fixture)).length, 0);
  assert.equal((await queued(fixture)).length, 1);
  assert.equal(runtime.sent.length, 1);
  await update(runtime, fixture, 101, 0, 'copy');
  await update(runtime, fixture, 101, 0, 'copy');
  assert.equal((await actions(fixture)).length, 1);
  assert.equal((await queued(fixture)).length, 2);
  assert.equal(runtime.sent.length, 2);
  assert.equal((await pool.query('SELECT 1 FROM nablon_processed_updates WHERE update_id=101')).rowCount, 0);
  assert.equal(runtime.legacy.length, 0);
});

test('restart after COMMIT delivers the same consequence without a second action', async () => {
  let fail = false;
  const first = transport({ failBeforeDrain: () => fail });
  first.bot.catch(error => { throw error; });
  const fixture = await open(first);
  fail = true;
  await assert.rejects(update(first, fixture, 201, 0, 'copy'), /COMMITTED_BEFORE_DRAIN/);
  const consequence = (await primary(fixture)).find(event => event.type === 'CONSEQUENCE_PREPARED');
  assert.equal((await queued(fixture)).at(-1).logical_key, 's3:' + consequence.eventId);
  assert.equal((await queued(fixture)).at(-1).status, 'PENDING');
  const restarted = transport();
  await update(restarted, fixture, 201, 0, 'copy');
  await update(restarted, fixture, 201, 0, 'delete');
  assert.equal((await actions(fixture)).length, 1);
  assert.equal((await queued(fixture)).length, 2);
  assert.equal((await queued(fixture)).at(-1).status, 'SENT');
  assert.deepEqual(restarted.sent.map(([, text]) => text), [C.consequences.two_of_three]);
});

test('Telegram API failure leaves a retryable send, API success leaves exposure unknown', async () => {
  let fail = false;
  const runtime = transport({ send: async () => {
    if (fail) throw new Error('SYNTHETIC_TELEGRAM_FAILURE');
  } });
  const fixture = await open(runtime);
  fail = true;
  await update(runtime, fixture, 301, 0, 'copy');
  const pending = (await queued(fixture)).at(-1);
  assert.equal(pending.status, 'PENDING');
  assert.equal((await actions(fixture)).length, 1);
  await pool.query('UPDATE nablon_outbox SET next_attempt_at=NOW() WHERE logical_key=$1', [pending.logical_key]);
  fail = false;
  await runtime.flush(20, fixture.context.episodeId);
  assert.equal((await queued(fixture)).at(-1).status, 'SENT');
  assert.equal((await queued(fixture)).at(-1).attempts, 2);
  await update(runtime, fixture, 302, 1, 'check');
  const history = await primary(fixture);
  const consequence = history.find(event => event.type === 'CONSEQUENCE_PREPARED');
  const nextAction = history.filter(event => event.type === 'ACTION_ACCEPTED')[1];
  const journal = await fixture.repository.readSource(fixture.context);
  const gate = createIntake({
    scenes: [[E.VERSION, 'S2'], [E.VERSION, 'S3']],
    readPrimaryEvents: id => id === fixture.context.episodeId ? primary(fixture) : [],
  });
  const result = await gate(intakePacket(journal, consequence.eventId, nextAction.eventId));
  assert.equal(result.status, 'accepted');
  assert.equal(result.reason, 'EXPOSURE_UNKNOWN');
  assert.equal(result.independence, 'unknown');
});

test('stale or foreign S3 callbacks leave no action, and ordinary updates still reach legacy deduplication', async () => {
  const runtime = transport();
  const fixture = await open(runtime);
  await update(runtime, fixture, 401, 0, 'copy');
  await update(runtime, fixture, 402, 0, 'copy');
  await update(runtime, fixture, 403, 1, 'copy', fixture.tg + 1000);
  await update(runtime, fixture, 404, 0, 'legacy');
  await update(runtime, fixture, 404, 0, 'legacy');
  assert.equal((await actions(fixture)).length, 1);
  assert.equal((await queued(fixture)).length, 2);
  assert.deepEqual(runtime.legacy, [404]);
});

test('user completes S2, recovers S3 after failure, and selects S4 from the unknown-exposure offer', async () => {
  let rollback = true;
  let afterCommit = false;
  const prior = transport({
    failBeforeDrain: () => afterCommit,
    writeEvent: async (args) => {
      if (rollback && args.scenario_id === 'S3' && args.event_name === RECEIPT_NAME) {
        rollback = false;
        throw new Error('S3_CHECKPOINT_INTERRUPTED');
      }
      return recordL0Event(args);
    },
  });
  prior.bot.catch(error => { throw error; });
  const s2 = await open(prior, 'S2');
  const buttons = runtime => runtime.sent.at(-1)[2].reply_markup.inline_keyboard.flat();
  const choose = (runtime, choice) => buttons(runtime).find(button => button.text === choice).callback_data;
  const listEpisodes = async () => (await pool.query(
    'SELECT id, scene_id, turn_index, status FROM nablon_episodes WHERE session_id=$1 ORDER BY scene_id',
    [s2.context.sessionId],
  )).rows;
  const current = async () => (await pool.query(
    'SELECT current_episode_id FROM nablon_sessions WHERE id=$1', [s2.context.sessionId],
  )).rows[0].current_episode_id;

  await press(prior, 501, s2.tg, choose(prior, 'copy'));
  assert.equal(prior.sent.at(-1)[1], C.consequences.two_of_three);
  const nextS2 = choose(prior, 'copy');
  await assert.rejects(press(prior, 502, s2.tg, nextS2), /S3_CHECKPOINT_INTERRUPTED/);
  assert.deepEqual((await listEpisodes()).map(row => [row.scene_id, row.turn_index]), [['S2', 1]]);
  assert.equal(await current(), s2.context.episodeId);
  assert.equal((await queued(s2)).length, 2);

  afterCommit = true;
  await assert.rejects(press(prior, 502, s2.tg, nextS2), /COMMITTED_BEFORE_DRAIN/);
  const s2History = await primary(s2);
  assert.equal(s2History.filter(event => event.type === 'ACTION_ACCEPTED').length, 2);
  const advance = s2History.find(event => event.type === 'SCENE_ADVANCED');
  assert.equal(await current(), advance.nextEpisodeId);
  assert.deepEqual((await listEpisodes()).map(row => row.scene_id), ['S2', 'S3']);

  await pool.end();
  pool = episodePool();
  s2.repository = createS3Repository(pool);
  const resumed = transport();
  await press(resumed, 502, s2.tg, nextS2);
  assert.deepEqual(resumed.sent.map(([, text]) => text), [C.consequences.three_of_three, C.scenarios.S3]);
  await press(resumed, 502, s2.tg, nextS2);
  await press(resumed, 503, s2.tg, nextS2);
  assert.equal(resumed.sent.length, 2);
  assert.deepEqual(await primary(s2), s2History);
  const s3 = { ...s2, context: { ...s2.context, episodeId: advance.nextEpisodeId } };
  assert.equal((await primary(s3))[0].previousEventId, advance.eventId);
  assert.equal((await s3.repository.readSource(s3.context)).state.current.turns, 0);

  for (const [index, action] of ['copy', 'copy', 'check', 'delete', 'copy'].entries()) {
    await press(resumed, 510 + index, s3.tg, choose(resumed, action));
  }
  const source = await s3.repository.readSource(s3.context);
  assert.equal(source.state.current.result, 'success');
  assert.equal(source.state.current.changed, false);
  assert.equal(E.offer(source.state), 'choice');
  assert.deepEqual(buttons(resumed).map(button => button.text), ['S4A', 'S4B']);
  const selection = choose(resumed, 'S4B');
  const stale = selection.replace(':5:', ':4:');
  await press(resumed, 520, s3.tg + 1000, selection);
  await press(resumed, 521, s3.tg, stale);
  assert.equal(await current(), s3.context.episodeId);
  assert.equal((await primary(s3)).some(event => event.type === 'BRANCH_SELECTED'), false);

  await press(resumed, 522, s3.tg, selection);
  const sent = resumed.sent.length;
  await press(resumed, 522, s3.tg, selection);
  await press(resumed, 523, s3.tg, selection.replace('S4B', 'S4A'));
  assert.equal(resumed.sent.length, sent);
  assert.equal(resumed.sent.at(-1)[1], C.scenarios.S4B);
  const s3History = await primary(s3);
  const chosen = s3History.filter(event => event.type === 'BRANCH_SELECTED');
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].offer, 'choice');
  assert.equal(chosen[0].nextSceneId, 'S4B');
  assert.equal(await current(), chosen[0].nextEpisodeId);
  const s4 = { ...s3.context, episodeId: chosen[0].nextEpisodeId };
  assert.equal((await s3.repository.readSource(s4)).state.current.id, 'S4B');
  assert.equal((await s3.repository.readPrimaryEvents(s4))[0].previousEventId, chosen[0].eventId);
  assert.deepEqual((await listEpisodes()).map(row => row.scene_id), ['S2', 'S3', 'S4B']);

  const consequence = s3History.find(event => event.consequence === 'copy_no_progress');
  const nextAction = s3History.find(event => event.type === 'ACTION_ACCEPTED' && event.sequence > consequence.sequence);
  const gate = createIntake({
    scenes: [[E.VERSION, 'S2'], [E.VERSION, 'S3']],
    readPrimaryEvents: id => id === s3.context.episodeId ? primary(s3) : [],
  });
  const finalSource = await s3.repository.readSource(s3.context);
  const result = await gate(intakePacket(finalSource, consequence.eventId, nextAction.eventId));
  assert.equal(result.status, 'accepted');
  assert.equal(result.reason, 'EXPOSURE_UNKNOWN');
  assert.equal(result.independence, 'unknown');
});

test('private preview admits only its owner, waits for trusted S2 state, and keeps original command IDs', async () => {
  const fixture = await createSession();
  const other = await createSession();
  const bot = new Telegraf('12345:test-only');
  bot.botInfo = { id: 12345, is_bot: true, first_name: 'Test', username: 'test_bot' };
  const sent = [];
  const replies = [];
  bot.telegram.sendMessage = async (...args) => { sent.push(args); };
  bot.use(async (ctx, next) => {
    ctx.reply = async (text) => { replies.push(text); };
    ctx.answerCbQuery = async () => {};
    return next();
  });
  let loaded = 0;
  let entry;
  registerPersonalPreview(bot, { pool, ownerTelegramId: fixture.tg, loadS2Entry: async (owner) => {
    assert.equal(owner, fixture.tg);
    loaded++;
    return entry;
  } });
  // This test intentionally rejects /start; do not let Telegraf's default
  // handler set process.exitCode=1 for the expected exception.
  bot.catch(error => { throw error; });
  const start = (id, sender, type = 'private') => bot.handleUpdate({
    update_id: id, message: { message_id: id, from: { id: sender, first_name: 'Test' },
      chat: { id: sender, type }, text: '/start', entities: [{ offset: 0, length: 6, type: 'bot_command' }] },
  });
  await start(601, other.tg);
  await start(602, fixture.tg, 'group');
  assert.equal(loaded, 0);
  assert.deepEqual(replies, []);
  const state = reachS2();
  state.current.delivery = 'unknown';
  entry = { context: fixture.context, state, commandId: 'owner-start' };
  await start(603, fixture.tg);
  assert.equal(replies.length, 1);
  assert.deepEqual(await primary(fixture), []);
  assert.deepEqual(sent, []);

  entry = { ...entry, state: syntheticS2Entry(), context: other.context };
  await start(604, fixture.tg);
  assert.equal(replies.length, 2);
  assert.deepEqual(await primary(other), []);
  entry = { ...entry, context: fixture.context };
  await assert.rejects(start(6045, fixture.tg), /Preview S2 isolation mismatch/);
  assert.deepEqual(await primary(fixture), []);
  await pool.query("UPDATE nablon_sessions SET training_id='NABLON_PERSONAL_PREVIEW' WHERE id=$1",
    [fixture.context.sessionId]);
  await start(605, fixture.tg);
  await start(606, fixture.tg);
  assert.equal(sent.length, 1);
  assert.equal(String(sent[0][0]), String(fixture.tg));
  assert.equal(sent[0][1], C.scenarios.S2);
  assert.equal((await primary(fixture)).length, 1);
  const firstSource = await fixture.repository.readSource(fixture.context);
  assert.equal(firstSource.state.current.delivery, 'unknown');
  assert.equal(firstSource.state.previewOnly, true);
  const buttons = () => sent.at(-1)[2].reply_markup.inline_keyboard.flat();
  const command = action => buttons().find(button => button.callback_data.endsWith(':' + action)).callback_data;
  const runtime = { bot };
  assert.deepEqual(buttons().map(button => button.text), ['Скопировать карточку', 'Открыть настройки']);
  await press(runtime, 607, other.tg, command('copy'));
  assert.deepEqual(await actions(fixture), []);
  await press(runtime, 608, fixture.tg, command('copy'));
  await press(runtime, 609, fixture.tg, command('copy'));
  assert.deepEqual(buttons().map(button => button.text),
    ['Скопировать карточку', 'Проверить сохранение', 'Удалить старый черновик']);
  for (const [index, action] of ['copy', 'copy', 'check', 'delete', 'copy'].entries()) {
    await press(runtime, 610 + index, fixture.tg, command(action));
  }
  assert.deepEqual(buttons().map(button => button.text), ['Задача про календарь', 'Задача про старую карточку']);
  const s3 = await pool.query("SELECT id FROM nablon_episodes WHERE session_id=$1 AND scene_id='S3'",
    [fixture.context.sessionId]);
  const s3Source = await fixture.repository.readSource({
    ...fixture.context, episodeId: s3.rows[0].id,
  });
  assert.equal(s3Source.state.episodes.find(e => e.id === 'S2').delivery, 'unknown');
  assert.equal(s3Source.state.episodes.find(e => e.id === 'S2').continued, false);
  assert.equal(E.offer(s3Source.state), 'choice');
  await press(runtime, 620, fixture.tg, command('S4A'));
  assert.equal(sent.at(-1)[1], C.scenarios.S4A);
});

test('preview /start creates a durable owner-only unknown S2 without a test fixture', async () => {
  const owner = ++telegramId;
  const bot = new Telegraf('12345:test-only');
  bot.botInfo = { id: 12345, is_bot: true, first_name: 'Test', username: 'test_bot' };
  const sent = [];
  bot.telegram.sendMessage = async (...args) => { sent.push(args); };
  bot.use(async (ctx,next) => {
    ctx.answerCbQuery = async () => {};
    return next();
  });
  registerPersonalPreview(bot, {
    pool, ownerTelegramId: owner, loadS2Entry: createPreviewEntryProvider(pool),
  });
  const start = (updateId, sender) => bot.handleUpdate({
    update_id: updateId,
    message: { message_id: updateId,
      from: { id: sender, first_name: 'Test' },
      chat: { id: sender, type: 'private' }, text: '/start',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }] },
  });
  await start(701, owner+1000);
  assert.equal(sent.length, 0);
  await start(702, owner);
  assert.equal(sent.length, 1);
  const found = await pool.query(
    `SELECT s.id, s.user_id, s.current_episode_id, s.training_id
     FROM nablon_sessions s JOIN users u ON u.id=s.user_id
     WHERE u.telegram_id=$1 AND s.status='ACTIVE'`, [owner]);
  assert.equal(found.rows.length, 1);
  assert.equal(found.rows[0].training_id, 'NABLON_PERSONAL_PREVIEW');
  const ctx = { userId: found.rows[0].user_id, sessionId: found.rows[0].id,
    episodeId: found.rows[0].current_episode_id };
  const repository = createS3Repository(pool);
  const opened = await repository.readSource(ctx);
  assert.equal(opened.state.current.id, 'S2');
  assert.equal(opened.state.current.delivery, 'unknown');
  assert.equal(opened.state.previewOnly, true);
  await start(703, owner);
  assert.equal(sent.length, 1);
  const buttons = sent[0][2].reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map(x=>x.text), ['Скопировать карточку','Открыть настройки']);
  await press({bot}, 704, owner, buttons.find(x=>x.callback_data.endsWith(':copy')).callback_data);
  const played = await repository.readSource(ctx);
  assert.equal(played.state.current.turns,1);
  assert.equal(played.state.current.delivery,'unknown');
  assert.equal(played.state.current.continued,false);
  assert.equal((await repository.readPrimaryEvents(ctx)).filter(e=>e.type==='ACTION_ACCEPTED').length,1);
});
