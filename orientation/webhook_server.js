'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const http = require('node:http');

function webhookCredentials(token) {
  if (!token) throw new Error('BOT_TOKEN is required');
  const secret = createHash('sha256').update('nablon-telegram-webhook-v1:').update(token).digest('hex');
  return { path: '/telegram/' + secret.slice(0, 32), secret };
}

function createWebhookServer(bot, token, { maxBytes = 1024 * 1024 } = {}) {
  const { path, secret } = webhookCredentials(token);
  const expected = Buffer.from(secret);
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== path) {
      res.writeHead(pathname === '/debug' ? 404 : 200, { 'Content-Type': 'text/plain' });
      res.end(pathname === '/debug' ? 'not found' : 'ok');
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    const actual = Buffer.from(typeof provided === 'string' ? provided : '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.writeHead(403); res.end(); return;
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      res.writeHead(415); res.end(); return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!update || !Number.isSafeInteger(update.update_id)) {
        res.writeHead(400); res.end(); return;
      }
      await bot.handleUpdate(update);
      res.writeHead(200); res.end('ok');
    } catch (error) {
      console.error('Try-only webhook update failed:', error.message);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
  });
  return { server, path, secret };
}

module.exports = { createWebhookServer, webhookCredentials };
