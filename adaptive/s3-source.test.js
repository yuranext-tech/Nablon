'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./engine');
const { createSource, apply, intakePacket, restoreSource } = require('./s3-source');

const FIXED_ID = '11111111-2222-4333-8444-555555555555';
function clock() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 10, 22, 10, 0, n++)).toISOString();
}
function reachS3() {
  const s = E.create();
  E.selectInterest(s, 'unknown');
  E.presentation(s, 'scenario', 'confirmed');
  E.act(s, 'add');
  E.presentation(s, 'consequence', 'confirmed', 1);
  E.next(s);
  E.presentation(s, 'scenario', 'confirmed');
  E.act(s, 'copy');
  E.presentation(s, 'consequence', 'confirmed', 1);
  E.act(s, 'copy');
  E.presentation(s, 'consequence', 'confirmed', 2);
  E.next(s);
  return s;
}
function recorder() {
  return createSource(reachS3(), { newId: () => FIXED_ID, now: clock() });
}
function action(j, id, name, now) {
  return apply(j, { commandId: id, kind: 'action', action: name }, { now });
}
function report(j, id, kind, delivery, turn, now) {
  return apply(j, { commandId: id, kind: 'presentation', presentationKind: kind, delivery, turn }, { now });
}

test('fresh S3 journal identifies a real episode and preserves original engine state', () => {
  const original = reachS3();
  const j = createSource(original, { newId: () => FIXED_ID, now: clock() });
  assert.deepEqual(j.state, original);
  assert.equal(j.events[0].sceneId, 'S3');
  assert.equal(j.events[0].sceneVersion, E.VERSION);
  assert.equal(j.events[0].eventId, `${FIXED_ID}:1`);
  assert.equal(original.events.some(e => e.eventId), false);
});

test('actions and consequences are distinct canonical events with command linkage', () => {
  const j = recorder(), now = clock();
  report(j, 'screen', 'scenario', 'confirmed', undefined, now);
  const first = action(j, 'update-1', 'copy', now);
  report(j, 'seen-1', 'consequence', 'confirmed', 1, now);
  const second = action(j, 'update-2', 'copy', now);
  assert.equal(first.status, 'APPLIED');
  assert.equal(second.status, 'APPLIED');
  assert.deepEqual(first.canonicalEvents.map(e => e.type), ['ACTION_ACCEPTED', 'CONSEQUENCE_PREPARED']);
  assert.equal(first.canonicalEvents[0].commandId, first.canonicalEvents[1].commandId);
  assert.equal(second.canonicalEvents[0].turn, 2);
  assert.deepEqual(j.events.map(e => e.sequence), Array.from({ length: j.events.length }, (_, i) => i + 1));
  assert.equal(j.state.current.noProgress, true);
  const packet = intakePacket(j, first.canonicalEvents[1].eventId, second.canonicalEvents[0].eventId);
  assert.equal(packet.sceneId, 'S3');
  assert.equal(packet.events.length, j.events.length);
});

test('repeat delivery is idempotent, changed same ID conflicts, and failed actions do not mutate', () => {
  const j = recorder(), now = clock();
  report(j, 'screen', 'scenario', 'confirmed', undefined, now);
  const once = action(j, 'u-100', 'copy', now);
  const baseline = JSON.stringify(j);
  assert.deepEqual(action(j, 'u-100', 'copy', now), { status: 'REPLAYED', canonicalEvents: once.canonicalEvents });
  assert.deepEqual(action(j, 'u-100', 'delete', now), { status: 'CONFLICT', canonicalEvents: [] });
  assert.equal(JSON.stringify(j), baseline);
  assert.throws(() => action(j, 'u-101', 'impossible', now), /invalid action/);
  assert.equal(JSON.stringify(j), baseline);
});

test('simulation presentation claims remain unverified facts, not exposure evidence', () => {
  const j = recorder(), now = clock();
  report(j, 'screen', 'scenario', 'confirmed', undefined, now);
  action(j, 'u-1', 'copy', now);
  report(j, 'presentation-1', 'consequence', 'confirmed', 1, now);
  const r = j.events.find(e => e.type === 'PRESENTATION_REPORTED' && e.presentationKind === 'consequence');
  assert.equal(r.deliveryClaim, 'confirmed');
  assert.equal(r.provenance, 'standalone-simulation');
  assert.equal(j.events.some(e => e.type === 'EXPOSURE_CONFIRMED'), false);
});

test('help request is logged separately from help display claim and action', () => {
  const j = recorder(), now = clock();
  report(j, 'screen', 'scenario', 'confirmed', undefined, now);
  action(j, 'u1', 'copy', now);
  report(j, 'consequence1', 'consequence', 'confirmed', 1, now);
  const req = apply(j, { commandId: 'help1', kind: 'help' }, { now });
  report(j, 'help-display', 'help', 'confirmed', undefined, now);
  const next = action(j, 'u2', 'check', now);
  assert.equal(req.canonicalEvents[0].type, 'HELP_REQUESTED');
  assert.equal(next.canonicalEvents[0].reportedHelp, 'unknown');
  assert.equal(j.events.some(e => e.type === 'HELP_PROVIDED_VERIFIED'), false);
});

test('JSON roundtrip keeps IDs and receipt history, restore rejects broken sequence', () => {
  let j = recorder(), now = clock();
  report(j, 'screen', 'scenario', 'confirmed', undefined, now);
  action(j, 'u1', 'copy', now);
  j = restoreSource(JSON.stringify(j));
  const before = JSON.stringify(j);
  assert.equal(action(j, 'u1', 'copy', now).status, 'REPLAYED');
  assert.equal(JSON.stringify(j), before);
  j.events[1].sequence = 999;
  assert.throws(() => restoreSource(JSON.stringify(j)), /Invalid S3 source snapshot/);
});

test('a finished S3 also records episode closing without modifying its result', () => {
  const j = recorder(), now = clock();
  report(j, 'screen', 'scenario', 'confirmed', undefined, now);
  for (const [i, name] of ['copy', 'delete', 'copy'].entries()) {
    action(j, `action-${i}`, name, now);
    report(j, `result-${i}`, 'consequence', 'confirmed', i + 1, now);
  }
  assert.equal(j.state.current.result, 'success');
  assert.equal(j.events.at(-1).type, 'PRESENTATION_REPORTED');
  assert(j.events.some(e => e.type === 'EPISODE_CLOSED' && e.result === 'success'));
});

test('S3 accepts action without a scenario presentation confirmation', () => {
  const j = recorder();
  const first = action(j, 'unknown-first', 'copy', clock());
  assert.equal(first.status, 'APPLIED');
  assert.equal(j.state.current.delivery, 'unknown');
  assert.equal(j.state.current.turns, 1);
});
