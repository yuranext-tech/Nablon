const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_ACTIONS, TrySceneManager } = require('../try_scene');
const { PROBES } = require('../probes');

function manager() {
  let value = 0;
  return new TrySceneManager({ tokenFactory: () => `scene_token_${String(++value).padStart(4, '0')}` });
}

function button(scene, label) {
  const row = scene.buttons.find(([candidate]) => candidate.text === label);
  assert.ok(row, `button ${label} is available`);
  return row[0].callback_data;
}

test('first deterministic scene progresses when the action is repeated', () => {
  const scenes = manager();
  const first = scenes.start(101);
  assert.equal(first.situation, 'repeat_progress');
  const repeated = scenes.handle(101, button(first, 'Повторить действие'), 'callback-1');
  assert.equal(repeated.status, 'APPLIED');
  assert.match(repeated.message, /два нужных пункта нашлись/);
  const result = scenes.handle(101, button(repeated, 'Узнать результат'), 'callback-2');
  assert.match(result.message, /повторение того же действия помогло/);
  assert.deepEqual(scenes.anonymousEvents(), [{
    type: 'try_action', situation: 'repeat_progress', action: 'repeat', outcome: 'progress',
  }]);
});

test('second deterministic scene needs a changed approach for progress', () => {
  const scenes = manager();
  scenes.start(101);
  const second = scenes.start(101);
  assert.equal(second.situation, 'change_progress');
  const repeated = scenes.handle(101, button(second, 'Повторить действие'), 'callback-1');
  assert.match(repeated.message, /нового результата нет/);
  const changed = scenes.handle(101, button(repeated, 'Изменить способ'), 'callback-2');
  assert.match(changed.message, /Смена способа дала прогресс/);
  const result = scenes.handle(101, button(changed, 'Узнать результат'), 'callback-3');
  assert.match(result.message, /смена способа помогла/);
  assert.deepEqual(scenes.anonymousEvents().map(({ action, outcome }) => ({ action, outcome })), [
    { action: 'repeat', outcome: 'no_progress' },
    { action: 'change', outcome: 'progress' },
  ]);
});

test('duplicate callbacks and old buttons cannot apply a second action', () => {
  const scenes = manager();
  const started = scenes.start(101);
  const oldButton = button(started, 'Повторить действие');
  assert.equal(scenes.handle(101, oldButton, 'callback-1').status, 'APPLIED');
  assert.equal(scenes.handle(101, oldButton, 'callback-1').status, 'DUPLICATE');
  assert.equal(scenes.handle(101, oldButton, 'callback-2').status, 'STALE');
  assert.equal(scenes.anonymousEvents().length, 1);
});

test('another Telegram user cannot operate a scene', () => {
  const scenes = manager();
  const started = scenes.start(101);
  const response = scenes.handle(202, button(started, 'Изменить способ'), 'foreign-callback');
  assert.equal(response.status, 'FOREIGN_USER');
  assert.equal(scenes.anonymousEvents().length, 0);
});

test('a repeat /try invalidates the old scene and alternates the situation', () => {
  const scenes = manager();
  const first = scenes.start(101);
  const second = scenes.start(101);
  assert.equal(second.situation, 'change_progress');
  assert.equal(scenes.handle(101, button(first, 'Завершить'), 'old-callback').status, 'STALE');
  assert.equal(scenes.handle(101, button(second, 'Завершить'), 'new-callback').terminal, true);
});

test('finish and action limit end a scene without changing other bot state', () => {
  const scenes = manager();
  const started = scenes.start(101);
  const finished = scenes.handle(101, button(started, 'Завершить'), 'finish-callback');
  assert.equal(finished.terminal, true);
  assert.match(finished.message, /Сцена завершена/);

  let current = scenes.start(202);
  for (let index = 0; index < MAX_ACTIONS; index += 1) {
    current = scenes.handle(202, button(current, 'Узнать результат'), `result-${index}`);
  }
  assert.equal(current.terminal, true);
  assert.match(current.message, /Достигнут лимит действий/);
  assert.equal(scenes.handle(202, button({ buttons: [[{ text: 'Завершить', callback_data: 'try:bad:0:finish' }]] }, 'Завершить'), 'ignored').status, 'STALE');
});

test('the scene has no side effect on the frozen numeric probe protocol', () => {
  const before = JSON.stringify(PROBES);
  const scenes = manager();
  const started = scenes.start(101);
  scenes.handle(101, button(started, 'Повторить действие'), 'callback-1');
  assert.equal(JSON.stringify(PROBES), before);
});
