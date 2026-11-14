'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installPollingWatchdog } = require('./polling_watchdog');

test('successful empty getUpdates responses keep an idle bot healthy', async () => {
  let time = 0, tick;
  const bot = { telegram: { async callApi() { return []; } } };
  let stalled = 0;
  const watchdog = installPollingWatchdog(bot, {
    now: () => time,
    onStall: () => stalled++,
    setIntervalFn: fn => { tick = fn; return { unref() {} }; },
    clearIntervalFn() {},
    maxSilenceMs: 150,
  });
  for (let i = 0; i < 5; i++) {
    time += 100;
    await bot.telegram.callApi('getUpdates', {});
    tick();
  }
  assert.equal(stalled, 0);
  watchdog.stop();
});

test('no successful polling responses trigger exactly one recovery', () => {
  let time = 0, tick;
  const bot = { telegram: { async callApi() { return true; } } };
  const stalls = [];
  const watchdog = installPollingWatchdog(bot, {
    now: () => time,
    onStall: info => stalls.push(info),
    setIntervalFn: fn => { tick = fn; return { unref() {} }; },
    clearIntervalFn() {},
    maxSilenceMs: 150,
  });
  time = 151;
  tick(); tick();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].observedSuccess, false);
  watchdog.stop();
});

test('unrelated Telegram API calls do not count as polling', async () => {
  let time = 0, tick, count = 0;
  const bot = { telegram: { async callApi() { return {}; } } };
  const watchdog = installPollingWatchdog(bot, {
    now: () => time,
    onStall: () => count++,
    setIntervalFn: fn => { tick = fn; return { unref() {} }; },
    clearIntervalFn() {},
    maxSilenceMs: 150,
  });
  time = 100;
  await bot.telegram.callApi('getMe');
  time = 151;
  tick();
  assert.equal(count, 1);
  watchdog.stop();
});

test('stopping restores original API method', () => {
  const original = async () => [];
  const bot = { telegram: { callApi: original } };
  const watchdog = installPollingWatchdog(bot, {
    onStall() {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
  });
  watchdog.stop();
  assert.equal(bot.telegram.callApi, original);
});
