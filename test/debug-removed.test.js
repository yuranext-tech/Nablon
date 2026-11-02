const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let handler;
let queries = 0;
const modules = {
  http: { createServer(fn) { handler = fn; return { listen() {} }; } },
  'node-cron': { schedule() {} },
  './migrate': { runMigration: () => new Promise(() => {}) },
  './bot': { bot: {}, dailyCronTick() {}, pool: { query() { queries++; throw Error('unexpected DB access'); } } },
};
const proc = { env: { BOT_TOKEN: 'synthetic-token' }, once() {}, exit() { throw Error('exit'); } };
vm.runInNewContext(fs.readFileSync(require.resolve('../index.js'), 'utf8'), {
  require: name => modules[name] || require(name), process: proc, console, setTimeout,
});
async function request(url) {
  let status, body;
  await handler({ url }, { writeHead(s) { status = s; }, end(b) { body = b; } });
  return { status, body };
}
(async () => {
  assert.deepEqual(await request('/'), { status: 200, body: 'ok' });
  assert.deepEqual(await request('/debug?key=synthetic-token'), { status: 404, body: 'not found' });
  delete proc.env.BOT_TOKEN;
  assert.deepEqual(await request('/debug'), { status: 404, body: 'not found' });
  assert.equal(queries, 0);
  console.log('PASS debug removed; health endpoint retained; no database access');
})().catch(e => { console.error(e); process.exitCode = 1; });
