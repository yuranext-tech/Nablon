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
assert.ok(bot.includes('NABLON_EPISODE_STARTED'));
assert.ok(bot.includes('NABLON_USER_RESPONDED'));
assert.ok(bot.includes('NABLON_PROMPT_SHOWN'));
assert.ok(bot.includes('NABLON_EPISODE_COMPLETED'));
assert.ok(bot.includes('NABLON_SET_COMPLETED'));
assert.ok(!bot.includes('ASK_BUTTON'));
assert.ok(bot.includes('nablon_routing_telemetry'));
assert.ok(bot.includes("ep.status==='WAITING_RESPONSE'"));
assert.ok(bot.includes("ep.status==='WAITING_NEW_DECISION'"));
assert.ok(bot.includes("if (!sc.intervention?.question)"));

const schema = fs.readFileSync('schema.sql','utf8');
for (const table of ['nablon_sessions','nablon_episodes','nablon_events','nablon_routing_telemetry']) {
  assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS ' + table));
}
console.log('Nablon runtime smoke tests: OK');
