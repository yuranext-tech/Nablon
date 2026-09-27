import { strict as assert } from 'node:assert';
import { Application } from '../src/r1/application/application';
import { InMemoryRepository } from '../src/r1/repository/repository';
import type { Command } from '../src/r1/domain/model';

let sequence = 0;
const id = (prefix: string) => `${prefix}-${++sequence}`;
const now = () => '2026-09-26T00:00:00.000Z';

function command(episodeId: string, version: number, type: Command['type'], commandId: string): Command {
  return { command_id: commandId, episode_id: episodeId, expected_version: version, type };
}

async function open(app: Application, episodeId: string) {
  return app.openEpisode(episodeId, 'user-1', id('open'));
}

async function T01_new_command() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t01';
  await open(app, episodeId);
  const result = await app.execute(command(episodeId, 1, 'START', 't01-command'));
  assert.equal(result.status, 'APPLIED');
  assert.equal(result.episode_version, 2);
  assert.equal(result.canonical_events.length, 1);
  assert.equal((await repo.getReceipt('t01-command'))?.result.status, 'APPLIED');
}

async function T02_retry_after_commit() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t02';
  await open(app, episodeId);
  const first = await app.execute(command(episodeId, 1, 'START', 't02-command'));
  const replay = await app.execute(command(episodeId, 1, 'START', 't02-command'));
  assert.equal(replay.status, 'REPLAYED');
  assert.equal(replay.command_id, first.command_id);
  assert.equal(replay.episode_version, first.episode_version);
  assert.deepEqual(replay.canonical_events, first.canonical_events);
  assert.equal((await repo.getEpisode(episodeId))?.version, 2);
}

async function T03_retry_after_another_command() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t03';
  await open(app, episodeId);
  const first = await app.execute(command(episodeId, 1, 'START', 't03-command'));
  await app.execute(command(episodeId, 2, 'STOP', 't03-other'));
  const replay = await app.execute(command(episodeId, 1, 'START', 't03-command'));
  assert.equal(replay.status, 'REPLAYED');
  assert.deepEqual(replay.canonical_events, first.canonical_events);
  assert.equal((await repo.getEpisode(episodeId))?.version, 3);
}

async function T04_stale_new_command() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t04';
  await open(app, episodeId);
  await app.execute(command(episodeId, 1, 'START', 't04-first'));
  const result = await app.execute(command(episodeId, 1, 'STOP', 't04-stale'));
  assert.equal(result.status, 'CONFLICT');
  assert.equal(result.episode_version, 2);
  assert.deepEqual(result.canonical_events, []);
  assert.equal(await repo.getReceipt('t04-stale'), null);
}

async function T05_composite_transition() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t05';
  await open(app, episodeId);
  const started = await app.execute(command(episodeId, 1, 'START', 't05-start'));
  const stopped = await app.execute(command(episodeId, 2, 'STOP', 't05-stop'));
  assert.equal(started.status, 'APPLIED');
  assert.equal(stopped.status, 'APPLIED');
  const composite = await app.execute(command(episodeId, 3, 'RECONSIDER_AND_CHANGE_APPROACH', 't05-composite'));
  assert.equal(composite.status, 'APPLIED');
  assert.equal(composite.canonical_events.length, 2);
  assert.deepEqual(composite.canonical_events.map((event) => event.type), ['RECONSIDER', 'CHANGE_APPROACH']);
  assert.equal(composite.canonical_events[0].command_id, 't05-composite');
  assert.equal(composite.canonical_events[1].command_id, 't05-composite');
  assert.equal(composite.canonical_events[0].sequence + 1, composite.canonical_events[1].sequence);
  assert.equal((await repo.getEpisode(episodeId))?.version, 4);
}

async function T06_rejected_attempts_are_ordered_in_raw_trace() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t06';
  await open(app, episodeId);
  await app.execute(command(episodeId, 1, 'START', 't06-start'));
  const firstRejected = await app.execute(command(episodeId, 2, 'START', 't06-rejected-1'));
  const secondRejected = await app.execute(command(episodeId, 2, 'START', 't06-rejected-2'));
  const applied = await app.execute(command(episodeId, 2, 'STOP', 't06-applied'));
  assert.equal(firstRejected.status, 'REJECTED');
  assert.equal(secondRejected.status, 'REJECTED');
  assert.equal(applied.status, 'APPLIED');
  const firstReceipt = await repo.getReceipt('t06-rejected-1');
  const secondReceipt = await repo.getReceipt('t06-rejected-2');
  const appliedReceipt = await repo.getReceipt('t06-applied');
  assert(firstReceipt);
  assert(secondReceipt);
  assert(appliedReceipt);
  assert.deepEqual([firstReceipt.trace_sequence, secondReceipt.trace_sequence, appliedReceipt.trace_sequence], [3, 4, 5]);
  assert.equal(firstReceipt.occurred_at, now());
  assert.equal(secondReceipt.occurred_at, now());
  assert.equal(appliedReceipt.occurred_at, now());
  assert.equal((await repo.getEpisode(episodeId))?.trace_sequence, 5);
}

async function run() {
  const tests = [T01_new_command, T02_retry_after_commit, T03_retry_after_another_command, T04_stale_new_command, T05_composite_transition, T06_rejected_attempts_are_ordered_in_raw_trace];
  for (const test of tests) await test();
  console.log(`PASS ${tests.length} R1 tests`);
}

void run().catch((error) => {
  console.error(error);
  throw error;
});
