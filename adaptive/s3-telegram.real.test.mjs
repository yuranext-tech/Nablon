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

before(async () => {
  const { rows: [db] } = await admin.query("SELECT current_setting('cluster_name') AS name, version()");
  assert.equal(db.name, 'eg-integration-p1-001');
  console.log(db.version);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  pool = new Pool({ connectionString, options: '-c search_path=' + schema });
  await pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
});
after(async () => {
  try {
    if (pool) await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally { await admin.end(); }
});

function reachS3() {
  const s = E.create();
  E.selectInterest(s, 'unknown');
  E.presentation(s, 'scenario', 'confirmed');
  E.act(s, 'add');
  E.next(s);
  E.presentation(s, 'scenario', 'confirmed');
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

async function open(runtime) {
  const tg = ++telegramId;
  const { rows: [user] } = await pool.query('INSERT INTO users(telegram_id) VALUES($1) RETURNING id', [tg]);
  const context = { userId: user.id, sessionId: randomUUID(), episodeId: randomUUID() };
  await pool.query(`INSERT INTO nablon_sessions(id,user_id,session_number,mode,training_id,status)
    VALUES ($1,$2,1,'demo','EG-S3-TELEGRAM','ACTIVE')`, [context.sessionId, user.id]);
  const result = await runtime.openS3(context, reachS3(), 'server-entry');
  assert.equal(result.status, 'APPLIED');
  assert.equal(runtime.sent[0][1], C.scenarios.S3);
  return { context, tg, repository: createS3Repository(pool) };
}

function update(runtime, { context, tg }, id, turn, action, from = tg) {
  const data = action === 'legacy' ? 'start_training' : `s3:${context.episodeId}:${turn}:${action}`;
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
