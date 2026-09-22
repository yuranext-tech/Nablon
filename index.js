// index.js — точка входа для Render (Web Service, бесплатный тариф)
const http = require('http');
const url = require('url');
const cron = require('node-cron');
const { runMigration } = require('./migrate');
const { bot, dailyCronTick, pool, resumeActiveSessions, flushOutbox } = require('./bot');

// Render Web Service (free tier) требует слушать порт и засыпает без обращений
// раз в ~15 минут. Health-check эндпоинт + внешний пинг (UptimeRobot) держат
// процесс живым бесплатно — тот же приём, что уже применялся в Impact.
//
// /debug?key=<BOT_TOKEN> — временный способ посмотреть данные из браузера без
// SQL-клиента. Защищён тем же токеном, что уже есть в env (репозиторий Public,
// поэтому без защиты адрес был бы открыт всем). Убрать после теста.
const PORT = process.env.PORT || 3000;
http
  .createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);

    if (parsed.pathname === '/debug') {
      if (parsed.query.key !== process.env.BOT_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      try {
        const users = await pool.query(
          'SELECT id, telegram_id, last_active_at FROM users ORDER BY id DESC LIMIT 100'
        );
        const sessions = await pool.query(
          'SELECT id, user_id, training_id, mode, current_episode_index, status, started_at, completed_at FROM nablon_sessions ORDER BY started_at DESC LIMIT 50'
        );
        const events = await pool.query(
          'SELECT id, user_id, session_id, episode_id, event_name, turn_index, payload, created_at FROM nablon_events ORDER BY created_at DESC LIMIT 100'
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ users: users.rows, sessions: sessions.rows, events: events.rows }, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('error: ' + err.message);
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  })
  .listen(PORT, () => console.log(`Health-check server on port ${PORT}`));

async function main() {
  await runMigration(); // применяет schema.sql — локальный SQL-клиент не нужен

  // На случай, если на боте случайно включён webhook (конфликтует с long polling
  // и даёт ровно 409 Conflict) — явно снимаем его и сбрасываем зависшую очередь.
  try {
    await bot.telegram.deleteWebhook();
  } catch (err) {
    console.error('deleteWebhook failed (non-fatal):', err.message);
  }

  // Restore active sessions before polling starts, so a process restart does not
  // strand a user on an episode that is already persisted as ACTIVE.
  await resumeActiveSessions();
  await flushOutbox(20);

  // launch() retries transient Telegram polling failures without killing the
  // health-check server.
  let launchRetryTimer = null;
  function launchWithRetry() {
    bot.launch().catch((err) => {
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
  if (launchRetryTimer) clearTimeout(launchRetryTimer);
  try { bot.stop(signal); } catch (e) { console.error('bot.stop failed:', e.message); }
  try { await pool.end(); } catch (e) { console.error('pool.end failed:', e.message); }
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
