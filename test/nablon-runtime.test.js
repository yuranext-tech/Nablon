const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const probes = fs.readFileSync('probes.js','utf8');
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(probes, sandbox);
const { SCENES, QUESTION_ANSWERS } = sandbox.module.exports;

assert.strictEqual(SCENES.length, 5);
assert.deepStrictEqual(SCENES.map(s => s.mode), ['CONTROL','TRAIN','TRAIN','TRANSFER','TRANSFER']);
assert.strictEqual(SCENES[0].intervention, undefined);
assert.ok(SCENES[1].intervention);
assert.ok(SCENES[2].intervention);
assert.strictEqual(SCENES[3].intervention, undefined);
assert.strictEqual(SCENES[4].intervention, undefined);
assert.ok(SCENES.every(s => s.structureId === 'condition_change_test'));

for (const s of SCENES) {
  assert.ok(s.prompt && s.id && s.context);
}

for (const key of ['purpose','why','example','life']) {
  assert.ok(QUESTION_ANSWERS[key]);
}

const bot = fs.readFileSync('bot.js','utf8');
assert.ok(bot.includes('NABLON_SESSION_STARTED'));
assert.ok(bot.includes('NABLON_EPISODE_STARTED'));
assert.ok(bot.includes('NABLON_USER_RESPONDED'));
assert.ok(bot.includes('NABLON_PROMPT_SHOWN'));
assert.ok(bot.includes('NABLON_EPISODE_COMPLETED'));
assert.ok(bot.includes('NABLON_SET_COMPLETED'));
assert.ok(bot.includes('NABLON_SESSION_RESUMED'));
assert.ok(bot.includes('async function resumeActiveSessions()'));
assert.ok(bot.includes("status IN ('WAITING_RESPONSE','WAITING_NEW_DECISION','INCOMPLETE')"));
assert.ok(bot.includes('process can die after the previous episode commits'));
assert.ok(bot.includes('const nextIndex = last ? Number(s.current_episode_index) + 1 : 0'));
assert.ok(bot.includes("status='WAITING_RESPONSE', completed_at=NULL"));
assert.ok(!bot.includes('drop_pending_updates'));
assert.ok(!bot.includes('ASK_BUTTON'));
assert.ok(bot.includes('nablon_routing_telemetry'));
assert.ok(bot.includes("ep.status==='WAITING_RESPONSE'"));
assert.ok(bot.includes("ep.status==='WAITING_NEW_DECISION'"));
assert.ok(bot.includes("if (!sc.intervention?.question)"));

const schema = fs.readFileSync('schema.sql','utf8');
for (const table of ['nablon_sessions','nablon_episodes','nablon_events','nablon_routing_telemetry','nablon_processed_updates','nablon_outbox']) {
  assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS ' + table));
}
console.log('Nablon runtime smoke tests: OK');

const sessionNumberSchema = fs.readFileSync('schema.sql','utf8');
assert.ok(sessionNumberSchema.includes('session_number INT NOT NULL'));
assert.ok(sessionNumberSchema.includes('idx_nablon_session_number'));
assert.ok(bot.includes('FOR UPDATE'));
assert.ok(bot.includes('MAX(session_number)'));

assert.ok(schema.includes("status TEXT NOT NULL CHECK (status IN ('PENDING','SENDING','SENT'))"));
assert.ok(schema.includes('logical_key TEXT NOT NULL UNIQUE'));
assert.ok(schema.includes('idx_nablon_outbox_pending'));
assert.ok(bot.includes('FOR UPDATE SKIP LOCKED'));
assert.ok(bot.includes('ON CONFLICT (logical_key) DO NOTHING'));
assert.ok(bot.includes("status='SENDING'"));
assert.ok(bot.includes('async function flushOutbox'));
assert.ok(bot.includes('enqueueOutbox(client'));
assert.ok(bot.includes('flushOutbox(1)'));

assert.ok(schema.includes('current_episode_id TEXT'));
assert.ok(schema.includes('fk_nablon_current_episode'));
assert.ok(bot.includes('WHERE id=$1 AND session_id=$2'));
assert.ok(bot.includes('Compatibility/recovery path for sessions created before current_episode_id'));
assert.ok(bot.includes('canonical prompt outbox item'));
assert.ok(!bot.includes("const resumeText = 'Продолжим с того места, где остановились."));
