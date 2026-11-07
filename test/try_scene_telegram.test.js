const assert = require('node:assert/strict');
const test = require('node:test');
const { TrySceneManager } = require('../try_scene');
const { registerTrySceneHandlers } = require('../try_scene_telegram');

function harness() {
  const handlers = {};
  const bot = {
    command(name, fn) { handlers[name] = fn; },
    on(name, fn) { handlers[name] = fn; },
  };
  let sequence = 0;
  const scenes = new TrySceneManager({
    tokenFactory: () => `scene_token_${String(++sequence).padStart(4, '0')}`,
  });
  registerTrySceneHandlers(bot, scenes);
  return { handlers, scenes };
}

function fakeCtx(user = 101) {
  const sent = [];
  const context = {
    from: { id: user },
    callbackQuery: null,
    sent,
    async reply(message, options) { sent.push({ kind: 'reply', message, options }); },
    async editMessageText(message, options) { sent.push({ kind: 'edit', message, options }); },
    async answerCbQuery() { sent.push({ kind: 'ack' }); },
  };
  return context;
}

test('Telegram command creates buttons; callback updates outcome without database', async () => {
  const { handlers, scenes } = harness();
  const ctx = fakeCtx();
  await handlers.try(ctx);
  assert.equal(ctx.sent[0].kind, 'reply');
  const options = ctx.sent[0].options;
  assert.equal(options.reply_markup.inline_keyboard.length, 4);
  const repeat = options.reply_markup.inline_keyboard[0][0].callback_data;
  ctx.callbackQuery = { data: repeat, id: 'click-1' };
  await handlers.callback_query(ctx);
  assert.equal(ctx.sent.at(-1).kind, 'edit');
  assert.match(ctx.sent.at(-1).message, /коробки доставлены/);
  assert.equal(scenes.anonymousEvents().length, 1);
  await handlers.callback_query(ctx);
  assert.equal(scenes.anonymousEvents().length, 1, 'duplicate must never create a second outcome');
});

test('Telegram edit error falls back to reply without repeating the action', async () => {
  const { handlers, scenes } = harness();
  const ctx = fakeCtx();
  await handlers.try(ctx);
  const change = ctx.sent[0].options.reply_markup.inline_keyboard[1][0].callback_data;
  ctx.callbackQuery = { data: change, id: 'click-2' };
  ctx.editMessageText = async () => { throw new Error('message cannot be edited'); };
  const originalError = console.error;
  console.error = () => {};
  try {
    await handlers.callback_query(ctx);
  } finally {
    console.error = originalError;
  }
  assert.equal(ctx.sent.at(-1).kind, 'reply');
  assert.equal(scenes.anonymousEvents().length, 1);
});

test('Telegram acknowledgement failure does not hide an accepted scene action', async () => {
  const { handlers, scenes } = harness();
  const ctx = fakeCtx();
  await handlers.try(ctx);
  const repeat = ctx.sent[0].options.reply_markup.inline_keyboard[0][0].callback_data;
  ctx.callbackQuery = { data: repeat, id: 'click-3' };
  ctx.answerCbQuery = async () => { throw new Error('callback timed out'); };
  const originalError = console.error;
  console.error = () => {};
  try {
    await handlers.callback_query(ctx);
  } finally {
    console.error = originalError;
  }
  assert.equal(ctx.sent.at(-1).kind, 'edit');
  assert.equal(scenes.anonymousEvents().length, 1);
});

test('Telegram callback for a different user is not applied', async () => {
  const { handlers, scenes } = harness();
  const owner = fakeCtx(101);
  await handlers.try(owner);
  const repeat = owner.sent[0].options.reply_markup.inline_keyboard[0][0].callback_data;
  const stranger = fakeCtx(202);
  stranger.callbackQuery = { data: repeat, id: 'foreign' };
  await handlers.callback_query(stranger);
  assert.equal(scenes.anonymousEvents().length, 0);
  assert.equal(stranger.sent.at(-1).kind, 'ack');
  assert.equal(stranger.sent.some(item => item.kind === 'edit'), false);
});
