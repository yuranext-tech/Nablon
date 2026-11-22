'use strict';

// Owner-only personal preview. Never import bot.js or index.js: they start the
// legacy runtime and may contain endpoints that are inappropriate for preview.
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { registerPersonalPreview, createPreviewEntryProvider } = require('./personal-preview');

async function main() {
  const token = process.env.PREVIEW_BOT_TOKEN;
  const databaseUrl = process.env.PREVIEW_DATABASE_URL;
  const ownerTelegramId = Number(process.env.PREVIEW_OWNER_TELEGRAM_ID);
  const expectedUsername = process.env.PREVIEW_EXPECTED_BOT_USERNAME?.replace(/^@/, '');
  if (!token || !databaseUrl || !expectedUsername ||
      !Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0) {
    throw new Error('PREVIEW_BOT_TOKEN, PREVIEW_DATABASE_URL, PREVIEW_OWNER_TELEGRAM_ID and PREVIEW_EXPECTED_BOT_USERNAME are required');
  }
  const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!/^nablon_personal_preview(?:_[a-z0-9_-]+)?$/i.test(database)) {
    throw new Error('Use a separate database named nablon_personal_preview (or nablon_personal_preview_*)');
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === databaseUrl)
    throw new Error('Preview database must differ from DATABASE_URL');
  const pool = new Pool({ connectionString: databaseUrl });
  const bot = new Telegraf(token);
  let timer;
  let started = false;
  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    if (timer) clearInterval(timer);
    if (started) bot.stop(signal);
    await pool.end();
  };
  process.once('SIGINT', () => { shutdown('SIGINT').catch(console.error); });
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch(console.error); });
  try {
    // Only this deliberately named isolated database is migrated.
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    const me = await bot.telegram.getMe();
    if (me.username.toLowerCase() !== expectedUsername.toLowerCase())
      throw new Error('Bot username mismatch: refusing to start preview');
    const { flushOutbox } = registerPersonalPreview(bot, {
      pool,
      ownerTelegramId,
      loadS2Entry: createPreviewEntryProvider(pool),
    });
    bot.catch(err => console.error('Preview update failed:', err.message));
    await bot.launch({ dropPendingUpdates: true });
    started = true;
    timer = setInterval(() => {
      flushOutbox(20).catch(err => console.error('Preview outbox error:', err.message));
    }, 30000);
    console.log('Owner-only Nablon preview ready: https://t.me/' + me.username);
    console.log('Personal walkthrough ends after opening S4; study data and Becoming are not used.');
  } catch (error) {
    await shutdown('STARTUP_FAILURE');
    throw error;
  }
}
main().catch(error => { console.error('Preview startup failed:', error.message); process.exitCode = 1; });
