import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

async function T05_reconsider_then_change_approach() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t05';
  await open(app, episodeId);
  await app.execute(command(episodeId, 1, 'START', 't05-start'));
  const stop = await app.execute(command(episodeId, 2, 'STOP', 't05-stop'));
  assert.equal(stop.status, 'APPLIED');
  assert.equal(stop.canonical_events[0].type, 'STOP');

  const reconsider = await app.execute(command(episodeId, 3, 'RECONSIDER', 't05-reconsider'));
  assert.equal(reconsider.status, 'APPLIED');
  assert.equal(reconsider.canonical_events.length, 1);
  assert.equal(reconsider.canonical_events[0].type, 'RECONSIDER');
  assert.equal(reconsider.canonical_events[0].command_id, 't05-reconsider');

  const change = await app.execute(command(episodeId, 4, 'CHANGE_APPROACH', 't05-change'));
  assert.equal(change.status, 'APPLIED');
  assert.equal(change.canonical_events.length, 1);
  assert.equal(change.canonical_events[0].type, 'CHANGE_APPROACH');
  assert.equal(change.canonical_events[0].command_id, 't05-change');
  assert.equal(change.canonical_events[0].sequence, reconsider.canonical_events[0].sequence + 1);
  assert.equal((await repo.getEpisode(episodeId))?.version, 5);
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

async function T07_concurrent_retry_and_independent_ordering() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t07';
  await open(app, episodeId);

  const initial = await app.execute(command(episodeId, 1, 'START', 't07-initial'));
  assert.equal(initial.status, 'APPLIED');

  const rejected1 = await app.execute(command(episodeId, 2, 'START', 't07-rejected-1'));
  const rejected2 = await app.execute(command(episodeId, 2, 'START', 't07-rejected-2'));
  const applied = await app.execute(command(episodeId, 2, 'STOP', 't07-applied'));
  assert.equal(rejected1.status, 'REJECTED');
  assert.equal(rejected2.status, 'REJECTED');
  assert.equal(applied.status, 'APPLIED');

  const r1 = await repo.getReceipt('t07-rejected-1');
  const r2 = await repo.getReceipt('t07-rejected-2');
  const r3 = await repo.getReceipt('t07-applied');
  assert(r1);
  assert(r2);
  assert(r3);
  assert.deepEqual([r1.trace_sequence, r2.trace_sequence, r3.trace_sequence], [3, 4, 5]);
  assert.deepEqual([r1.result.episode_version, r2.result.episode_version, r3.result.episode_version], [2, 2, 3]);

  const repo2 = new InMemoryRepository();
  const app2 = new Application(repo2, now, id.bind(null, 'event'));
  const episodeId2 = 'ep-t07-concurrent';
  await open(app2, episodeId2);
  const cmd = command(episodeId2, 1, 'START', 't07-concurrent-command');
  const [first, second] = await Promise.all([app2.execute(cmd), app2.execute(cmd)]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, ['APPLIED', 'REPLAYED']);
  assert.equal(first.command_id, second.command_id);
  assert.equal(first.episode_version, 2);
  assert.equal(second.episode_version, 2);

  const receipt = await repo2.getReceipt(cmd.command_id);
  assert(receipt);
  assert.equal(receipt.result.status, 'APPLIED');
  assert.equal(receipt.trace_sequence, 2);
  assert.equal((await repo2.getEpisode(episodeId2))?.trace_sequence, 2);
  assert.equal((await repo2.getEpisode(episodeId2))?.version, 2);
}

async function T08_atomic_rollback_includes_raw_trace() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t08';
  await open(app, episodeId);
  const before = await repo.getEpisode(episodeId);
  assert(before);

  repo.setFailAfterMutationOnce();
  await assert.rejects(
    app.execute(command(episodeId, 1, 'START', 't08-failing')),
    /injected_atomic_failure/,
  );

  const after = await repo.getEpisode(episodeId);
  assert.deepEqual(after, before);
  assert.equal(await repo.getReceipt('t08-failing'), null);

  const retry = await app.execute(command(episodeId, 1, 'START', 't08-retry'));
  assert.equal(retry.status, 'APPLIED');
  assert.equal((await repo.getEpisode(episodeId))?.version, 2);
  assert.equal((await repo.getEpisode(episodeId))?.trace_sequence, 2);
  assert.equal((await repo.getReceipt('t08-retry'))?.trace_sequence, 2);
}

function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listSourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

async function T09a_r1_core_has_no_external_dependency() {
  const root = join(process.cwd(), 'src', 'r1');
  const files = listSourceFiles(root);
  const forbidden = [
    'telegraf',
    "from 'pg'",
    'from "pg"',
    'measurement',
    'evidence',
    'becoming',
  ];

  for (const file of files) {
    const source = readFileSync(file, 'utf8').toLowerCase();
    for (const token of forbidden) {
      assert.equal(
        source.includes(token.toLowerCase()),
        false,
        `R1 core imports/references forbidden external concern: ${token} in ${file}`,
      );
    }
  }
}

async function T09b_domain_does_not_depend_on_repository() {
  const domainFiles = listSourceFiles(join(process.cwd(), 'src', 'r1', 'domain'));
  for (const file of domainFiles) {
    const source = readFileSync(file, 'utf8');
    assert.equal(source.includes('/repository/'), false, `domain imports repository: ${file}`);
    assert.equal(source.includes('../repository'), false, `domain imports repository: ${file}`);
    assert.equal(source.includes('Repository'), false, `domain references Repository: ${file}`);
  }
}

async function T10_episode_creation_has_one_canonical_application_path() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t10';

  const result = await open(app, episodeId);
  assert.equal(result.status, 'APPLIED');
  assert.equal(result.episode_version, 1);
  assert.equal(result.canonical_events.length, 1);
  assert.equal(result.canonical_events[0].type, 'EPISODE_OPENED');

  const episode = await repo.getEpisode(episodeId);
  const receipt = await repo.getReceipt(result.command_id);
  assert(episode);
  assert(receipt);
  assert.deepEqual(episode.event_ids, [result.canonical_events[0].event_id]);
  assert.equal(episode.version, 1);
  assert.equal(episode.trace_sequence, 1);
  assert.equal(receipt.trace_sequence, 1);
  assert.deepEqual(receipt.result, result);

  const duplicate = await app.execute(command(episodeId, 1, 'OPEN_EPISODE', 't10-duplicate-open'));
  assert.equal(duplicate.status, 'REJECTED');
  assert.equal((await repo.getEpisode(episodeId))?.version, 1);
  assert.equal((await repo.getEpisode(episodeId))?.trace_sequence, 2);
  assert.equal((await repo.getReceipt('t10-duplicate-open'))?.result.status, 'REJECTED');
}

async function T11_rejected_receipt_is_idempotent_and_replayable() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t11';
  await open(app, episodeId);

  const first = await app.execute(command(episodeId, 1, 'START', 't11-start'));
  assert.equal(first.status, 'APPLIED');

  const rejected = await app.execute(command(episodeId, 2, 'START', 't11-rejected-command'));
  assert.equal(rejected.status, 'REJECTED');

  const stored = await repo.getReceipt('t11-rejected-command');
  assert(stored);
  assert.equal(stored.result.status, 'REJECTED');
  assert.equal(stored.trace_sequence, 3);
  assert.equal(stored.result.episode_version, 2);
  assert.deepEqual(stored.result.canonical_events, []);

  const replay = await app.execute(command(episodeId, 2, 'START', 't11-rejected-command'));
  assert.equal(replay.status, 'REPLAYED');
  assert.equal(replay.episode_version, 2);
  assert.deepEqual(replay.canonical_events, []);
  assert.equal((await repo.getEpisode(episodeId))?.version, 2);
  assert.equal((await repo.getEpisode(episodeId))?.trace_sequence, 3);
  assert.equal((await repo.getReceipt('t11-rejected-command'))?.trace_sequence, 3);
}

async function run() {
  const tests = [
    T01_new_command,
    T02_retry_after_commit,
    T03_retry_after_another_command,
    T04_stale_new_command,
    T05_reconsider_then_change_approach,
    T06_rejected_attempts_are_ordered_in_raw_trace,
    T07_concurrent_retry_and_independent_ordering,
    T08_atomic_rollback_includes_raw_trace,
    T09a_r1_core_has_no_external_dependency,
    T09b_domain_does_not_depend_on_repository,
    T10_episode_creation_has_one_canonical_application_path,
    T11_rejected_receipt_is_idempotent_and_replayable,
  ];
  for (const test of tests) await test();
  console.log(`PASS ${tests.length} R1 tests`);
}

void run().catch((error) => {
  console.error(error);
  throw error;
});
