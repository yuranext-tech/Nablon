'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createWebhookServer, webhookCredentials } = require('./webhook_server');

async function withServer(fn) {
  const updates = [];
  const { server, path, secret } = createWebhookServer({ handleUpdate: async u => updates.push(u) }, 'test:token');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn({ port: server.address().port, path, secret, updates }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function request(port, path, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
}
test('rejects unauthorized webhook requests without handling updates', async () => {
  await withServer(async ({ port, path, updates }) => {
    assert.equal(await request(port, path, { 'content-type': 'application/json' }, '{"update_id":1}'), 403);
    assert.equal(updates.length, 0);
  });
});
test('accepts authenticated Telegram update', async () => {
  await withServer(async ({ port, path, secret, updates }) => {
    assert.equal(await request(port, path, {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    }, '{"update_id":42,"message":{"text":"/try"}}'), 200);
    assert.equal(updates[0].update_id, 42);
  });
});
test('health path does not expose debug and webhook credentials are deterministic', async () => {
  await withServer(async ({ port, path }) => {
    assert.equal(await request(port, '/debug'), 404);
    assert.equal(await request(port, '/'), 200);
    assert.equal(webhookCredentials('test:token').path, path);
  });
});
