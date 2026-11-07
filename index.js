// index.js — точка входа для Render (Web Service, бесплатный тариф)
const http = require('http');
const url = require('url');
const cron = require('node-cron');
const { runMigration } = require('./migrate');
const { bot, dailyCronTick, pool, resumeActiveSessions, flushOutbox } = require('./bot');

const PORT = process.env.PORT || 3000;
http
  .createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);

    if (parsed.pathname === '/debug') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  })
  .listen(PORT, () => console.log(`Health-check server on port ${PORT}`));

let launchRetryTimer = null;

async function main() {
  await runMigration();

  try {
    await bot.telegram.deleteWebhook();
  } catch (err) {
    console.error('deleteWebhook failed (non-fatal):', err.message);
  }

  await resumeActiveSessions();
  await flushOutbox(20);

  function launchWithRetry() {
    if (launchRetryTimer) {
      clearTimeout(launchRetryTimer);
      launchRetryTimer = null;
    }
    bot.launch().catch((err) => {
      if (shuttingDown) return;
      console.error('bot.launch() failed:', err.message, '— retry in 15s');
      launchRetryTimer = setTimeout(launchWithRetry, 15000);
    });
  }
  launchWithRetry();
  console.log('Bot launch attempted (long polling).');

  cron.schedule('* * * * *', () => {
    flushOutbox(20).catch((err) => console.error('outbox error:', err));
  });

  cron.schedule('*/5 * * * *', () => {
    dailyCronTick().catch((err) => console.error('dailyCronTick error:', err));
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (launchRetryTimer) {
    clearTimeout(launchRetryTimer);
    launchRetryTimer = null;
  }
  try { bot.stop(signal); } catch (e) { console.error('bot.stop failed:', e.message); }
  try { await pool.end(); } catch (e) { console.error('pool.end failed:', e.message); }
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
