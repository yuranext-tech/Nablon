// index.js — точка входа для Render (Web Service, бесплатный тариф)
const http = require('http');
const url = require('url');
const cron = require('node-cron');
const { runMigration } = require('./migrate');
const { bot, dailyCronTick, pool } = require('./bot');

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
          'SELECT id, telegram_id, state, last_probe_code, preferred_slot_hour, last_active_at FROM users ORDER BY id DESC'
        );
        const observations = await pool.query(
          `SELECT id, user_id, probe_code, event_type, event_phase, response_payload, structured_fields, is_valid, invalid_reason, created_at
           FROM observations ORDER BY created_at DESC LIMIT 20`
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ users: users.rows, observations: observations.rows }, null, 2));
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
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    console.error('deleteWebhook failed (non-fatal):', err.message);
  }

  // launch() раньше падал необработанной ошибкой и убивал весь процесс при
  // любом 409 — из-за этого один конфликт приводил к бесконечному циклу
  // перезапусков. Теперь ошибка логируется и попытка повторяется через 15с,
  // а не роняет health-check сервер и не оставляет бота молчащим навсегда.
  function launchWithRetry() {
    bot.launch().catch((err) => {
      console.error('bot.launch() failed:', err.message, '— retry in 15s');
      setTimeout(launchWithRetry, 15000);
    });
  }
  launchWithRetry();
  console.log('Bot launch attempted (long polling).');

  cron.schedule('*/5 * * * *', () => {
    dailyCronTick().catch((err) => console.error('dailyCronTick error:', err));
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));  function launchWithRetry() {
    bot.launch().catch((err) => {
      console.error('bot.launch() failed:', err.message, '— retry in 15s');
      setTimeout(launchWithRetry, 15000);
    });
  }
  launchWithRetry();
  console.log('Bot launch attempted (long polling).');

  cron.schedule('*/5 * * * *', () => {
    dailyCronTick().catch((err) => console.error('dailyCronTick error:', err));
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));        res.writeHead(500, { 'Content-Type': 'text/plain' });
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
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    console.error('deleteWebhook failed (non-fatal):', err.message);
  }

  // launch() раньше падал необработанной ошибкой и убивал весь процесс при
  // любом 409 — из-за этого один конфликт приводил к бесконечному циклу
  // перезапусков. Теперь ошибка логируется, а не роняет health-check сервер.
  bot.launch().catch((err) => {
    console.error('bot.launch() failed:', err.message);
    console.error('Bot is NOT running. Health-check server stays up so Render does not restart in a loop.');
  });
  console.log('Bot launch attempted (long polling).');

  cron.schedule('*/5 * * * *', () => {
    dailyCronTick().catch((err) => console.error('dailyCronTick error:', err));
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));process.once('SIGTERM', () => bot.stop('SIGTERM'));
