const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('explicit try-only entry fails safely without token, never contacts PostgreSQL', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, NABLON_RUNTIME_MODE: 'try-only', BOT_TOKEN: '' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /BOT_TOKEN is required/);
  assert.doesNotMatch(result.stderr, /Migration failed|DATABASE_URL|pg-pool|ENOTFOUND/);
});

test('isolated runtime has no legacy database or cron imports', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'try_only_runtime.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"](?:\.\/)?(?:bot|migrate|node-cron|pg)['"]\)/);
  assert.match(src, /drop_pending_updates: false/);
});
