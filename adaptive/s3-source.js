'use strict';

// EG-S3-SOURCE-001: observational adapter for the *standalone* S3 prototype.
// Does not alter the scenario, result calculation or routing. The caller owns
// durable/atomic persistence and must route ALL S3 commands through apply().
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const engine = require('./engine');

const SCENE = 'S3';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const iso = () => new Date().toISOString();
const clone = value => structuredClone(value);

function append(journal, type, commandId, fields, now) {
  const sequence = journal.events.length + 1;
  journal.events.push({
    type, ...fields,
    episodeId: journal.episodeId,
    eventId: `${journal.episodeId}:${sequence}`,
    sequence, commandId,
    occurredAt: now(),
  });
}

function createSource(state, { newId = randomUUID, now = iso } = {}) {
  if (state?.current?.id !== SCENE || state.current.turns !== 0 || state.current.done ||
      !state.events?.some(event => event.type === 'episode_started' && event.episode === SCENE) ||
      state.version !== engine.VERSION) {
    throw new Error('S3 must have just started via the original engine');
  }
  const episodeId = newId();
  if (!uuid.test(episodeId)) throw new Error('Invalid episode ID');
  const journal = { format: 's3-source-v0.1', episodeId, sceneId: SCENE,
    sceneVersion: engine.VERSION, state: clone(state), events: [], receipts: [] };
  append(journal, 'EPISODE_OPENED', `open:${episodeId}`,
    { sceneId: SCENE, sceneVersion: engine.VERSION }, now);
  return journal;
}

// Transport supplies an immutable command ID (e.g. Telegram update ID).
// A repeated ID with an identical request replays; changed content conflicts.
// A successful command and its journal must be persisted together by the caller.
function apply(journal, request, { now = iso } = {}) {
  if (!journal || journal.format !== 's3-source-v0.1' ||
      typeof request?.commandId !== 'string' || !request.commandId ||
      !['action', 'help', 'presentation'].includes(request.kind)) {
    throw new Error('Invalid journal or command');
  }
  const previous = journal.receipts.find(item => item.commandId === request.commandId);
  if (previous) return isDeepStrictEqual(previous.request, request)
    ? { status: 'REPLAYED', canonicalEvents: clone(previous.canonicalEvents) }
    : { status: 'CONFLICT', canonicalEvents: [] };

  // Clone before invoking the original engine so a thrown command cannot leave
  // the stored state half changed. No new interpretation is introduced here.
  const next = engine.restore(JSON.stringify(journal.state));
  if (next.current?.id !== SCENE) throw new Error('Not in S3');
  const before = next.events.length;
  if (request.kind === 'action') engine.act(next, request.action);
  else if (request.kind === 'help') engine.help(next);
  else engine.presentation(next, request.presentationKind, request.delivery, request.turn);

  const delta = next.events.slice(before);
  const made = [];
  const record = (type, fields) => {
    const sequence = journal.events.length + made.length + 1;
    made.push({ type, ...fields, episodeId: journal.episodeId,
      eventId: `${journal.episodeId}:${sequence}`, sequence,
      commandId: request.commandId, occurredAt: now() });
  };
  if (request.kind === 'action') {
    const action = delta.find(item => item.type === 'action' && item.episode === SCENE);
    if (!action || delta.filter(item => item.type === 'action').length !== 1) throw new Error('Unrecorded action');
    record('ACTION_ACCEPTED', { action: action.action, turn: action.turn,
      reportedHelp: action.help });
    record('CONSEQUENCE_PREPARED', { consequence: action.consequence });
    const ended = delta.find(item => item.type === 'episode_finished');
    if (ended) record('EPISODE_CLOSED', { result: ended.result });
  } else if (request.kind === 'help') {
    if (!delta.some(item => item.type === 'help_requested')) throw new Error('Unrecorded help request');
    record('HELP_REQUESTED', {});
  } else {
    if (!delta.some(item => item.type === 'presentation')) throw new Error('Unrecorded presentation report');
    // It is a SIMULATION REPORT, never a trusted observation of screen display.
    record('PRESENTATION_REPORTED', { presentationKind: request.presentationKind,
      deliveryClaim: request.delivery, turn: request.turn ?? null,
      provenance: 'standalone-simulation' });
  }
  journal.state = next;
  journal.events.push(...made);
  journal.receipts.push({ commandId: request.commandId, request: clone(request), canonicalEvents: clone(made) });
  return { status: 'APPLIED', canonicalEvents: clone(made) };
}

function intakePacket(journal, consequenceId, nextActionId) {
  return { episodeId: journal.episodeId, sceneId: journal.sceneId,
    sceneVersion: journal.sceneVersion, consequenceId, nextActionId,
    events: clone(journal.events) };
}

function restoreSource(json) {
  const source = JSON.parse(json);
  if (source?.format !== 's3-source-v0.1' || !uuid.test(source.episodeId) ||
      source.sceneId !== SCENE || source.sceneVersion !== engine.VERSION ||
      !Array.isArray(source.events) || !Array.isArray(source.receipts) ||
      source.events[0]?.type !== 'EPISODE_OPENED' ||
      source.events[0]?.sceneId !== SCENE ||
      source.events.some((event, i) => event.episodeId !== source.episodeId ||
        event.eventId !== `${source.episodeId}:${i+1}` || event.sequence !== i+1)) {
    throw new Error('Invalid S3 source snapshot');
  }
  source.state = engine.restore(JSON.stringify(source.state));
  return source;
}

module.exports = { createSource, apply, intakePacket, restoreSource };
