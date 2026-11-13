const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomInt, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { initialState, advance, screen, INTRO } = require('../orientation/episode');
const { createRepository } = require('../orientation/repository');
const { registerOrientation } = require('../orientation/telegram');

test('opening the folder displays the two dated files without another instruction', () => {
  assert.equal(INTRO, 'NABLON · ОЗНАКОМЛЕНИЕ 01\n\nПоследняя копия\n\nНужно открыть последнюю версию файла «План».\n\nСейчас перед тобой папка «Материалы».\n\nЧто сделаешь?');
  const opened = advance(initialState(), 'open', 1);
  const view = screen({ id: 'example', version: 2, state: opened.state });
  assert.equal(view.message, 'В папке два файла: «План — 12 ноября» и «План — 14 ноября». Ни один пока не открыт.');
  assert.deepEqual(view.buttons.flat().map((button) => button.text),
    ['Открыть от 12 ноября', 'Открыть от 14 ноября', 'Завершить']);
  assert.equal(opened.state.understanding, 'unverified');
});

test('either file confirms interface understanding, but only the latest reaches the goal', () => {
  const files = advance(initialState(), 'open', 1).state;
  const old = advance(files, 'old', 2).state;
  assert.equal(old.understanding, 'confirmed');
  assert.equal(old.goal, 'pending');
  assert.equal(advance(old, 'latest', 3).state.goal, 'reached');
  const latest = advance(files, 'latest', 2).state;
  assert.equal(latest.understanding, 'confirmed');
  assert.equal(latest.goal, 'reached');
});

test('stop at either screen records no confirmation and help remains distinct', () => {
  const initial = initialState();
  const files = advance(initial, 'open', 1).state;
  assert.equal(advance(initial, 'finish', 1).state.understanding, 'unverified');
  assert.equal(advance(files, 'finish', 2).state.understanding, 'unverified');
  assert.equal(advance(files, 'old', 2).events[0].precedingVersion, 2);
  const helped = advance(files, 'help', 2);
  assert.deepEqual(helped.events.map((event) => event.type), ['HELP_REQUESTED', 'HELP_PREPARED']);
  assert.equal(advance(helped.state, 'latest', 3).state.understanding, 'assisted');
});

const url = process.env.NABLON_ORIENTATION_TEST_DATABASE_URL;
test('isolated PostgreSQL and synthetic Telegram end to end', { skip: !url && 'Set NABLON_ORIENTATION_TEST_DATABASE_URL to a disposable database' }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());
  await pool.query(readFileSync(join(__dirname, '../orientation/schema.sql'), 'utf8'));
  const { rows: [db] } = await pool.query('SELECT version()');
  t.diagnostic(db.version);

  function telegram(repository, fail = false) {
    const handlers = {};
    registerOrientation({
      command(name, fn) { handlers[name] = fn; },
      on(name, fn) { handlers[name] = fn; },
    }, repository, 'synthetic-test-key');
    return async (event, updateId, data, user = 100) => {
      const messages = [];
      const present = (method) => async (message, options) => {
        if (fail === true || fail === method) throw new Error('synthetic Telegram failure');
        messages.push({ message, options });
      };
      await handlers[event]({
        from: { id: user }, chat: { type: 'private' }, update: { update_id: updateId },
        callbackQuery: { data }, reply: present('reply'), editMessageText: present('edit'), answerCbQuery: async () => {},
      });
      return messages[0];
    };
  }
  function button(result, label) {
    return result.options.reply_markup.inline_keyboard.flat().find((item) => item.text === label).callback_data;
  }
  const owner = (suffix) => 'test-' + randomUUID() + '-' + suffix;

  await t.test('Telegram route continues after replacing the application and its DB pool', async (caseTest) => {
    const firstPool = new Pool({ connectionString: url });
    caseTest.after(() => { if (!firstPool.ending) return firstPool.end(); });
    const user = randomInt(10_000_000, 10_000_000_000);
    const before = telegram(createRepository(firstPool));
    const intro = await before('try', 1, null, user);
    const open = button(intro, 'Открыть папку');
    const files = await before('callback_query', 2, open, user);
    await firstPool.end();
    const after = telegram(createRepository(pool));
    const resumed = await after('try', 3, null, user);
    assert.deepEqual(resumed, files);
    const old = button(resumed, 'Открыть от 12 ноября');
    const foreign = await after('callback_query', 4, old, user + 10_000_000_000);
    assert.match(foreign.message, /больше недоступен/);
    const outcome = await after('callback_query', 5, old, user);
    assert.match(outcome.message, /более свежий/);
    assert.deepEqual(await after('callback_query', 5, old, user), outcome);
    const episodeId = open.split(':')[1];
    const { rows } = await pool.query(
      'SELECT fact FROM nablon_orientation_events WHERE episode_id=$1 ORDER BY sequence', [episodeId],
    );
    assert.deepEqual(rows.map((row) => row.fact.type), [
      'EPISODE_OPENED', 'SCENARIO_PREPARED', 'ACTION_ACCEPTED', 'CONSEQUENCE_PREPARED',
      'ACTION_ACCEPTED', 'INTERFACE_CHECK_RECORDED', 'CONSEQUENCE_PREPARED',
    ]);
    assert.equal(rows[4].fact.precedingVersion, 2);
    assert.equal(rows[5].fact.result, 'confirmed');
  });

  await t.test('failed Telegram send leaves the prepared result recoverable on replay and fresh button retries', async () => {
    const user = randomInt(10_000_000, 10_000_000_000);
    const initial = await telegram(createRepository(pool))('try', 1, null, user);
    const open = button(initial, 'Открыть папку');
    const episodeId = open.split(':')[1];
    assert.equal(await telegram(createRepository(pool), true)('callback_query', 2, open, user), undefined);
    const sent = () => pool.query(
      'SELECT episode_version, method FROM nablon_orientation_telegram_sends WHERE episode_id=$1 ORDER BY id',
      [episodeId],
    ).then(({ rows }) => rows);
    assert.deepEqual(await sent(), [{ episode_version: 1, method: 'reply' }]);
    const recovered = telegram(createRepository(pool));
    const files = await recovered('callback_query', 2, open, user);
    assert.match(files.message, /два файла/);
    assert.deepEqual(await telegram(createRepository(pool), 'edit')('callback_query', 3, open, user), files);
    assert.deepEqual(await sent(), [
      { episode_version: 1, method: 'reply' }, { episode_version: 2, method: 'edit' },
      { episode_version: 2, method: 'reply' },
    ]);
    const { rows } = await pool.query(
      'SELECT fact FROM nablon_orientation_events WHERE episode_id=$1 ORDER BY sequence', [episodeId],
    );
    assert.deepEqual(rows.map((row) => row.fact.type),
      ['EPISODE_OPENED', 'SCENARIO_PREPARED', 'ACTION_ACCEPTED', 'CONSEQUENCE_PREPARED']);
  });

  await t.test('lost final message is recovered through /try in a fresh process without opening an episode', async () => {
    const user = randomInt(10_000_000, 10_000_000_000);
    const before = telegram(createRepository(pool));
    const intro = await before('try', 1, null, user);
    const open = button(intro, 'Открыть папку');
    const files = await before('callback_query', 2, open, user);
    const latest = button(files, 'Открыть от 14 ноября');
    const id = latest.split(':')[1];
    assert.equal(await telegram(createRepository(pool), true)('callback_query', 3, latest, user), undefined);
    const script = `
      const { Pool } = require('pg');
      const { registerOrientation } = require('./orientation/telegram');
      const { createRepository } = require('./orientation/repository');
      const pool = new Pool({ connectionString: process.env.NABLON_ORIENTATION_TEST_DATABASE_URL });
      const handlers = {};
      registerOrientation({
        command(name, handler) { handlers[name] = handler; },
        on() {},
      }, createRepository(pool), 'synthetic-test-key');
      handlers.try({
        chat: { type: 'private' }, from: { id: Number(process.argv[1]) }, update: { update_id: 4 },
        reply: async (message) => process.stdout.write(message),
      }).finally(() => pool.end());
    `;
    const child = await run(process.execPath, ['-e', script, String(user)], { cwd: join(__dirname, '..') });
    assert.match(child.stdout, /Это последняя версия/);
    const { rows } = await pool.query(
      'SELECT id, version, active, state FROM nablon_orientation_episodes WHERE owner_ref=(SELECT owner_ref FROM nablon_orientation_episodes WHERE id=$1)',
      [id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].version, 3);
    assert.equal(rows[0].active, false);
    assert.equal(rows[0].state.goal, 'reached');
    const lateReplay = await before('callback_query', 2, open, user);
    assert.match(lateReplay.message, /Это последняя версия/);
    assert.deepEqual(lateReplay.options.reply_markup.inline_keyboard, []);
    const reopened = await before('try_again', 5, null, user);
    assert.notEqual(button(reopened, 'Открыть папку').split(':')[1], id);
  });

  await t.test('/help finds the active episode and records each distinct request once', async () => {
    const user = randomInt(10_000_000, 10_000_000_000);
    const after = telegram(createRepository(pool));
    const outsideEpisode = await after('help', 0, null, user);
    assert.ok(outsideEpisode.message.includes('Открой /try'));
    const intro = await after('try', 1, null, user);
    const open = button(intro, 'Открыть папку');
    await after('callback_query', 2, open, user);
    const helped = await after('help', 3, null, user);
    assert.match(helped.message, /^Нажми кнопку с действием/);
    assert.deepEqual(await after('help', 3, null, user), helped);
    const helpedAgain = await after('help', 4, null, user);
    assert.equal(helpedAgain.message, helped.message);
    const old = button(helpedAgain, 'Открыть от 12 ноября');
    await after('callback_query', 5, old, user);
    const { rows } = await pool.query(
      'SELECT fact FROM nablon_orientation_events WHERE episode_id=$1 ORDER BY sequence', [open.split(':')[1]],
    );
    assert.equal(rows.filter((row) => row.fact.type === 'HELP_REQUESTED').length, 2);
    assert.equal(rows.filter((row) => row.fact.type === 'HELP_PREPARED').length, 2);
    assert.equal(rows.find((row) => row.fact.type === 'INTERFACE_CHECK_RECORDED').fact.result, 'assisted');
    assert.equal(rows.filter((row) => row.fact.type === 'ACTION_ACCEPTED').length, 2);
  });

  await t.test('concurrent identical commands replay and changed input conflicts', async () => {
    const user = owner('race');
    const repo = createRepository(pool);
    const start = await repo.execute(user, 'start', { action: 'start' });
    const request = { action: 'open', episodeId: start.episode.id, version: 1 };
    const results = await Promise.all([
      repo.execute(user, 'update', request),
      repo.execute(user, 'update', request),
      repo.execute(user, 'other', { ...request, action: 'finish' }),
    ]);
    // The distinct finish command may win the lock. The identical pair still applies at most once.
    if (results[2].status === 'APPLIED') {
      assert.deepEqual(results.slice(0, 2).map((r) => r.status).sort(), ['REJECTED', 'REPLAYED']);
    } else {
      assert.deepEqual(results.slice(0, 2).map((r) => r.status).sort(), ['APPLIED', 'REPLAYED']);
      assert.equal(results[2].status, 'CONFLICT');
      assert.equal(results[2].version, 2);
    }
    assert.equal((await repo.execute(user, 'update', { ...request, action: 'finish' })).status, 'CONFLICT');
    const { rows: [episode] } = await pool.query('SELECT version FROM nablon_orientation_episodes WHERE id=$1', [request.episodeId]);
    assert.equal(episode.version, 2);
  });

  await t.test('failure during receipt write rolls back state and events, retry applies once', async () => {
    const user = owner('rollback');
    const repo = createRepository(pool);
    const start = await repo.execute(user, 'start', { action: 'start' });
    const request = { action: 'open', episodeId: start.episode.id, version: 1 };
    const failing = createRepository({
      async connect() {
        const client = await pool.connect();
        return {
          query(sql, args) {
            if (sql.startsWith('INSERT INTO nablon_orientation_receipts')) return client.query('SELECT 1/0');
            return client.query(sql, args);
          },
          release: () => client.release(),
        };
      },
    });
    await assert.rejects(failing.execute(user, 'update', request), /division by zero/);
    const { rows: [episode] } = await pool.query('SELECT version FROM nablon_orientation_episodes WHERE id=$1', [request.episodeId]);
    assert.equal(episode.version, 1);
    const applied = await repo.execute(user, 'update', request);
    assert.deepEqual(applied.canonicalEvents.map((event) => event.sequence), [3, 4]);
  });
  await t.test('retry after a lost COMMIT response returns the stored result', async () => {
    const user = owner('commit');
    const repo = createRepository(pool);
    const start = await repo.execute(user, 'start', { action: 'start' });
    const request = { action: 'open', episodeId: start.episode.id, version: 1 };
    const missingAck = createRepository({
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, args) {
            const result = await client.query(sql, args);
            if (sql === 'COMMIT') throw new Error('simulated lost COMMIT response');
            return result;
          },
          release: () => client.release(),
        };
      },
    });
    await assert.rejects(missingAck.execute(user, 'update', request), /lost COMMIT/);
    const replay = await createRepository(pool).execute(user, 'update', request);
    assert.equal(replay.status, 'REPLAYED');
    assert.equal(replay.originalStatus, 'APPLIED');
    assert.equal(replay.episode.state.stage, 'files');
    assert.deepEqual(replay.canonicalEvents.map((event) => event.sequence), [3, 4]);
    const { rows } = await pool.query(
      'SELECT sequence FROM nablon_orientation_events WHERE episode_id=$1 ORDER BY sequence', [start.episode.id],
    );
    assert.deepEqual(rows.map((row) => row.sequence), [1, 2, 3, 4]);
  });

});
