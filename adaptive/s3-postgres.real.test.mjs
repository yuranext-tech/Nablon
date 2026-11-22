import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const E = require('./engine');
const { createS3Repository } = require('./s3-postgres');
const { recordL0Event } = require('../nablon/runtime/l0-events');
const { intakePacket } = require('./s3-source');

const url = process.env.EG_S3_TEST_DATABASE_URL;
const intakePath = process.env.EG_INTAKE_PATH;
if (!url || !intakePath) throw Error('Set EG_S3_TEST_DATABASE_URL (disposable PostgreSQL cluster) and EG_INTAKE_PATH (pinned f3773e6 intake.mjs).');
const { createIntake } = await import(pathToFileURL(resolve(intakePath)).href);
function reachS3() {
  const s = E.create(); E.selectInterest(s, 'unknown'); E.presentation(s, 'scenario', 'confirmed');
  E.act(s, 'add'); E.presentation(s, 'consequence', 'confirmed', 1); E.next(s);
  E.presentation(s, 'scenario', 'confirmed'); E.act(s, 'copy');
  E.presentation(s, 'consequence', 'confirmed', 1); E.act(s, 'copy');
  E.presentation(s, 'consequence', 'confirmed', 2); E.next(s); return s;
}
const sceneVersion = E.VERSION;
test('real PostgreSQL: atomic rollback/replay + separate primary read, exposure unknown', async () => {
  const admin = new Pool({ connectionString: url });
  const schema = 'eg_s3_' + randomUUID().replaceAll('-', '');
  let pool;
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"');
    pool = new Pool({ connectionString: url, options: '-c search_path=' + schema });
    await pool.query(readFileSync(resolve(import.meta.dirname, '../schema.sql'), 'utf8'));
    const user = await pool.query('INSERT INTO users(telegram_id) VALUES($1) RETURNING id', [9_001_001]);
    const userId = user.rows[0].id, sessionId = 'eg-s3-' + randomUUID();
    const episodeId = randomUUID(), ctx = {userId, sessionId, episodeId};
    await pool.query(`INSERT INTO nablon_sessions(id,user_id,session_number,mode,training_id,status)
      VALUES ($1,$2,1,'demo','EG-S3-SOURCE-001','ACTIVE')`, [sessionId, userId]);
    let inject = false;
    const repository = createS3Repository(pool, { writeEvent: async (args) => {
      if (inject && args.event_name === 'S3_CANONICAL_EVENT' &&
          args.payload.event.type === 'CONSEQUENCE_PREPARED') {
        inject = false; throw new Error('INJECTED_ROLLBACK');
      }
      return recordL0Event(args);
    }});
    assert.equal((await repository.start(ctx, reachS3(), 'start')).status, 'APPLIED');
    inject = true;
    await assert.rejects(repository.execute(ctx, {commandId:'u1', kind:'action', action:'copy'}), /INJECTED_ROLLBACK/);
    assert.equal((await repository.readPrimaryEvents(ctx)).filter(x=>x.type==='ACTION_ACCEPTED').length, 0);
    const first = await repository.execute(ctx, {commandId:'u1', kind:'action', action:'copy'});
    assert.equal(first.status, 'APPLIED');
    assert.deepEqual(await repository.execute(ctx, {commandId:'u1', kind:'action', action:'copy'}),
      {...first, status:'REPLAYED'});
    assert.equal((await repository.execute(ctx, {commandId:'u1', kind:'action', action:'delete'})).status, 'CONFLICT');
    await pool.query('SELECT pg_sleep(0.03)');
    const second = await repository.execute(ctx, {commandId:'u2',kind:'action',action:'check'});
    const primary = await repository.readPrimaryEvents(ctx);
    const source = await repository.readSource(ctx);
    assert.deepEqual(primary, source.events);
    assert.equal(primary.filter(x=>x.type==='ACTION_ACCEPTED').length, 2);
    const packet = intakePacket(source, first.canonicalEvents[1].eventId, second.canonicalEvents[0].eventId);
    const gate = createIntake({scenes:[[sceneVersion,'S2'],[sceneVersion,'S3']],
      readPrimaryEvents: async (id)=> id===episodeId ? repository.readPrimaryEvents(ctx) : []});
    const result = await gate(packet);
    assert.equal(result.status,'accepted');
    assert.equal(result.reason,'EXPOSURE_UNKNOWN');
    assert.equal(result.independence,'unknown');
  } finally {
    if (pool) await pool.end();
    await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await admin.end();
  }
});
