import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Application } from '../src/r1/application/application';
import { InMemoryRepository } from '../src/r1/repository/repository';
import type { Command, Episode } from '../src/r1/domain/model';
import type { Repository } from '../src/r1/repository/repository';
import type { Receipt } from '../src/r1/application/types';
import type { CanonicalEvent } from '../src/r1/domain/model';

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
  const stop = await app.execute(command(episodeId, 1, 'START', 't05-start'));
  const stop2 = await app.execute(command(episodeId, 2, 'STOP', 't05-stop'));
  const reconsider = await app.execute(command(episodeId, 3, 'RECONSIDER', 't05-reconsider'));
  const change = await app.execute(command(episodeId, 4, 'CHANGE_APPROACH', 't05-change'));
  assert.equal(stop.status, 'APPLIED');
  assert.deepEqual([...stop2.canonical_events, ...reconsider.canonical_events, ...change.canonical_events].map((e) => e.type), [
    'STOP', 'RECONSIDER', 'CHANGE_APPROACH',
  ]);
}

async function T06_atomic_failure() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t06';
  await open(app, episodeId);
  const before = await repo.getEpisode(episodeId);
  repo.setFailAfterMutationOnce();
  await assert.rejects(() => app.execute(command(episodeId, 1, 'START', 't06-command')), /injected_atomic_failure/);
  assert.deepEqual(await repo.getEpisode(episodeId), before);
  assert.equal(await repo.getReceipt('t06-command'), null);
  const retry = await app.execute(command(episodeId, 1, 'START', 't06-command'));
  assert.equal(retry.status, 'APPLIED');
}

class DelayedSaveRepository implements Repository {
  constructor(private readonly inner: InMemoryRepository, private readonly delayMs: number) {}
  getEpisode(id: string) { return this.inner.getEpisode(id); }
  getReceipt(id: string) { return this.inner.getReceipt(id); }
  async saveEpisodeAtomically(episode: Episode, events: CanonicalEvent[], receipt: Receipt) {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.saveEpisodeAtomically(episode, events, receipt);
  }
  withEpisodeLock<T>(episodeId: string, operation: () => Promise<T>) {
    return this.inner.withEpisodeLock(episodeId, operation);
  }
}

async function T07_concurrent_same_command_id() {
  const inner = new InMemoryRepository();
  const repo = new DelayedSaveRepository(inner, 50);
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t07';
  await open(app, episodeId);
  const same = command(episodeId, 1, 'START', 't07-same-command');
  const started = Date.now();
  const [a, b] = await Promise.all([app.execute(same), app.execute({ ...same })]);
  const elapsed = Date.now() - started;
  assert(elapsed >= 45, `expected real overlapping async execution; elapsed=${elapsed}ms`);
  assert.deepEqual(new Set([a.status, b.status]), new Set(['APPLIED', 'REPLAYED']));
  const applied = a.status === 'APPLIED' ? a : b;
  const replayed = a.status === 'REPLAYED' ? a : b;
  assert.deepEqual(replayed.canonical_events, applied.canonical_events);
  assert.equal(replayed.command_id, applied.command_id);
  const stored = await inner.getReceipt('t07-same-command');
  assert(stored);
  assert.equal(stored.result.status, 'APPLIED');
  assert.deepEqual(stored.result, applied);
  assert.equal((await inner.getEpisode(episodeId))?.version, 2);
}

async function T08_rejected_command() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const episodeId = 'ep-t08';
  await open(app, episodeId);
  const first = await app.execute(command(episodeId, 1, 'STOP', 't08-rejected'));
  assert.equal(first.status, 'REJECTED');
  assert.deepEqual(first.canonical_events, []);
  assert.deepEqual((await repo.getReceipt('t08-rejected'))?.result, first);
  const replay = await app.execute(command(episodeId, 1, 'STOP', 't08-rejected'));
  assert.equal(replay.status, 'REPLAYED');
  assert.deepEqual(replay.canonical_events, []);
  assert.equal((await repo.getEpisode(episodeId))?.version, 1);
}

async function T09_episode_creation() {
  const repo = new InMemoryRepository();
  const app = new Application(repo, now, id.bind(null, 'event'));
  const result = await app.openEpisode('ep-t09', 'user-t09', 't09-open');
  assert.equal(result.status, 'APPLIED');
  assert.equal(result.episode_version, 1);
  assert.deepEqual(result.canonical_events.map((e) => e.type), ['EPISODE_OPENED']);
  assert.equal((await repo.getEpisode('ep-t09'))?.event_ids.length, 1);
  await assert.rejects(() => app.openEpisode('ep-t09', 'user-t09', 't09-open-2'), /episode_already_exists/);
}

function findFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? findFiles(path) : [path];
  });
}

async function T10_forbidden_dependencies() {
  const root = join(process.cwd(), 'src', 'r1', 'domain');
  const bad = findFiles(root).filter((file) => /repository|persistence|infrastructure/i.test(readFileSync(file, 'utf8')));
  assert.deepEqual(bad.map((p) => relative(process.cwd(), p)), []);
}

async function T11_domain_repository_dependency_boundary() {
  const domainRoot = join(process.cwd(), 'src', 'r1', 'domain');
  const repositoryRoot = join(process.cwd(), 'src', 'r1', 'repository');
  const domainFiles = findFiles(domainRoot);
  const repositoryFiles = findFiles(repositoryRoot);
  const forbiddenDomainImports = domainFiles.flatMap((file) =>
    readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => /^\s*import\b/.test(line) && /repository|persistence|infrastructure/i.test(line))
      .map((line) => ({ file, line })),
  );
  assert.deepEqual(forbiddenDomainImports, []);
  const forbiddenRepositoryDecisions = repositoryFiles.flatMap((file) =>
    readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => /reduce\(|case\s+'(START|STOP|RECONSIDER|CHANGE_APPROACH|COMPLETE)'/.test(line))
      .map((line) => ({ file, line })),
  );
  assert.deepEqual(forbiddenRepositoryDecisions, []);
  const application = readFileSync(join(process.cwd(), 'src', 'r1', 'application', 'application.ts'), 'utf8');
  assert(application.includes("from '../domain/model'"));
  assert(application.includes("from '../repository/repository'"));
}

const tests: Array<[string, () => Promise<void>]> = [
  ['T01 new command', T01_new_command],
  ['T02 retry after commit', T02_retry_after_commit],
  ['T03 retry after another command', T03_retry_after_another_command],
  ['T04 stale new command', T04_stale_new_command],
  ['T05 composite transition', T05_composite_transition],
  ['T06 atomic failure', T06_atomic_failure],
  ['T07 concurrent same command_id', T07_concurrent_same_command_id],
  ['T08 rejected command', T08_rejected_command],
  ['T09 episode creation', T09_episode_creation],
  ['T10 forbidden dependencies', T10_forbidden_dependencies],
  ['T11 domain/repository dependency boundary', T11_domain_repository_dependency_boundary],
];

async function main() {
  for (const [name, test] of tests) {
    await test();
    console.log(`PASS ${name}`);
  }
}

void main();
