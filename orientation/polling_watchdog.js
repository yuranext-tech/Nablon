'use strict';

// Detect a stalled Telegram getUpdates loop without treating user silence as failure.
// Telegraf's polling transport uses telegram.callApi('getUpdates', ...).
function installPollingWatchdog(bot, { now = Date.now, onStall, intervalMs = 30000, maxSilenceMs = 150000, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (!bot?.telegram?.callApi || typeof onStall !== 'function') throw new TypeError('Polling watchdog requires Telegram API and onStall');
  const telegram = bot.telegram;
  const original = telegram.callApi;
  let lastSuccess = now();
  let started = false;
  let stopped = false;
  let stalled = false;
  telegram.callApi = async function (method, ...args) {
    const result = await original.call(this, method, ...args);
    if (method === 'getUpdates' && !stopped) {
      lastSuccess = now();
      started = true;
    }
    return result;
  };
  const timer = setIntervalFn(() => {
    if (stopped || stalled) return;
    const elapsed = now() - lastSuccess;
    if (elapsed > maxSilenceMs) {
      stalled = true;
      onStall({ elapsedMs: elapsed, observedSuccess: started });
    }
  }, intervalMs);
  timer.unref?.();
  return {
    reset() { lastSuccess = now(); started = false; stalled = false; },
    stop() { stopped = true; clearIntervalFn(timer); telegram.callApi = original; },
  };
}
module.exports = { installPollingWatchdog };
