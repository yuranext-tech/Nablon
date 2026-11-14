'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureOrientationSchema } = require('./ensure_schema');

function mockPool(failSchema = false) {
  const queries = [];
  let released = false;
  return {
    queries,
    get released() { return released; },
    async connect() {
      return {
        async query(sql) {
          queries.push(sql);
          if (failSchema && sql.includes('CREATE TABLE')) throw new Error('schema failed');
        },
        release() { released = true; },
      };
    },
  };
}

test('creates all four orientation tables inside one transaction', async () => {
  const pool = mockPool();
  await ensureOrientationSchema(pool);
  assert.equal(pool.queries[0], 'BEGIN');
  assert.equal(pool.queries.at(-1), 'COMMIT');
  assert.equal(pool.queries.length, 3);
  const sql = pool.queries[1];
  for (const table of [
    'nablon_orientation_episodes',
    'nablon_orientation_events',
    'nablon_orientation_receipts',
    'nablon_orientation_telegram_sends',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS nablon_orientation_one_active/);
  assert.equal(pool.released, true);
});

test('rolls back and releases connection on a schema error', async () => {
  const pool = mockPool(true);
  await assert.rejects(ensureOrientationSchema(pool), /schema failed/);
  assert.equal(pool.queries[0], 'BEGIN');
  assert.equal(pool.queries.at(-1), 'ROLLBACK');
  assert.equal(pool.queries.includes('COMMIT'), false);
  assert.equal(pool.released, true);
});
