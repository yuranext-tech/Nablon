const assert = require('node:assert/strict');
const test = require('node:test');
const { createHealthServer } = require('../health');

function request(server, url) {
  let status;
  let body;
  const handler = server.listeners('request')[0];
  handler({ url }, {
    writeHead: (value) => { status = value; },
    end: (value) => { body = value; },
  });
  return { status, body };
}

test('health server has no public debug data route', () => {
  const server = createHealthServer();
  assert.deepEqual(request(server, '/'), { status: 200, body: 'ok' });
  assert.deepEqual(request(server, '/debug?key=anything'), { status: 404, body: 'not found' });
});
