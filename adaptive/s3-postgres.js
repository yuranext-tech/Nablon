'use strict';

// EG-S3-SOURCE-001. Reuses nablon_events as an immutable canonical fact log
// and per-command durable checkpoint/receipt. No schema extension or new service.
// This is a repository boundary, NOT an enabled Telegram route.
const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');
const engine = require('./engine');
const { createSceneSource, apply, restoreSource, recordTransition } = require('./s3-source');
const { recordL0Event } = require('../nablon/runtime/l0-events');
const FORMAT = 's3-source-v0.1';
const EVENT_NAME = 'S3_CANONICAL_EVENT';
const RECEIPT_NAME = 'S3_COMMAND_RECEIPT';
const VERSION = 'adaptive-set-v0.1';
const clone = x => structuredClone(x);

function requireContext(context) {
  if (!context || !Number.isSafeInteger(context.userId) || context.userId <= 0 ||
      typeof context.sessionId !== 'string' || !context.sessionId ||
      typeof context.episodeId !== 'string' || !context.episodeId) {
    throw new Error('Invalid S3 context');
  }
}
function time(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid database timestamp');
  return date.toISOString();
}
function createS3Repository(pool, { writeEvent = recordL0Event, prepareReply } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool required');
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* original error takes precedence */ }
      throw error;
    } finally { client.release(); }
  }
  async function lock(client, context) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['s3:' + context.episodeId]);
    const session = await client.query(
      'SELECT id, current_episode_id, status FROM nablon_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [context.sessionId, context.userId]);
    if (session.rowCount !== 1) throw new Error('S3 session not found or unauthorized');
    return session.rows[0];
  }
  async function episodeRow(client, context) {
    const result = await client.query(
      'SELECT id, scene_id, session_id, status FROM nablon_episodes WHERE id=$1 AND session_id=$2 FOR UPDATE',
      [context.episodeId, context.sessionId]);
    return result.rows[0] ?? null;
  }
  async function latest(client, context) {
    const result = await client.query(
      `SELECT payload FROM nablon_events WHERE user_id=$1 AND session_id=$2
         AND episode_id=$3 AND event_name=$4 ORDER BY id DESC LIMIT 1`,
      [context.userId, context.sessionId, context.episodeId, RECEIPT_NAME]);
    return result.rows[0]?.payload ?? null;
  }
  function args(context, sceneId, eventName, turnIndex, payload) {
    return { client: null, event_name: eventName, user_id: context.userId,
      session_id: context.sessionId, episode_id: context.episodeId,
      set_id: FORMAT, scenario_id: sceneId, turn_index: turnIndex,
      program_version: VERSION, runtime_version: FORMAT, payload };
  }
  async function facts(client, context, source, generated) {
    const byId = new Map();
    for (const event of generated) {
      const input = args(context, source.sceneId, EVENT_NAME, event.turn ?? 0, { event });
      const row = await writeEvent({ ...input, client });
      // PostgreSQL is the authoritative clock. The adapter's in-memory time
      // never upgrades a Telegram send acknowledgement into an exposure fact.
      byId.set(event.eventId, { ...event, occurredAt: time(row.occurred_at) });
    }
    source.events = source.events.map(e => byId.get(e.eventId) ?? e);
    source.receipts = source.receipts.map(r => ({ ...r,
      canonicalEvents: r.canonicalEvents.map(e => byId.get(e.eventId) ?? e) }));
    return generated.map(e => byId.get(e.eventId));
  }
  async function checkpoint(client, context, commandId, request, source, response) {
    await writeEvent({ ...args(context, source.sceneId, RECEIPT_NAME, source.state.current?.turns ?? 0,
      { commandId, request, source: clone(source), response: clone(response) }), client });
  }
  function replay(receipt, request) {
    const previous = receipt.source?.receipts?.find(x => x.commandId === request.commandId);
    if (!previous) return null;
    return isDeepStrictEqual(previous.request, request)
      ? { status: 'REPLAYED', canonicalEvents: clone(previous.canonicalEvents) }
      : { status: 'CONFLICT', canonicalEvents: [] };
  }

  async function openEpisode(client, context, state, sceneId, request, previousEpisodeId = null) {
    const source = createSceneSource(state, sceneId, { newId: () => context.episodeId });
    if (previousEpisodeId) source.events[0].previousEventId = request.previousEventId;
    await client.query(`INSERT INTO nablon_episodes
      (id, session_id, scene_id, turn_index, status, support_stage)
      VALUES ($1,$2,$3,0,'WAITING_RESPONSE','NONE')`,
    [context.episodeId, context.sessionId, sceneId]);
    if (sceneId === 'S2' || previousEpisodeId || prepareReply) {
      const assigned = await client.query(
        `UPDATE nablon_sessions SET current_episode_id=$1 WHERE id=$2 AND user_id=$3 AND status='ACTIVE'
           AND current_episode_id IS NOT DISTINCT FROM $4::text`,
        [context.episodeId, context.sessionId, context.userId, previousEpisodeId],
      );
      if (assigned.rowCount !== 1) throw new Error('Episode is not the current transition');
    }
    const saved = await facts(client, context, source, source.events);
    source.receipts.push({ commandId: request.commandId, request, canonicalEvents: clone(saved) });
    const response = { status: 'APPLIED', canonicalEvents: clone(saved) };
    if (prepareReply) await prepareReply(client, context, source.state.current, saved);
    await checkpoint(client, context, request.commandId, request, source, response);
    return response;
  }

  async function startScene(context, state, commandId, sceneId) {
    requireContext(context);
    if (typeof commandId !== 'string' || !commandId) throw new Error('Start command ID required');
    // The opening request is immutable; retries do not re-run the engine.
    const request = { kind: 'start', commandId, state: clone(state) };
    return transaction(async client => {
      await lock(client, context);
      const ep = await episodeRow(client, context);
      const earlier = await latest(client, context);
      if (earlier) {
        if (ep?.scene_id !== sceneId) throw new Error('Scene mismatch');
        const opened = earlier.source?.receipts?.find(x => x.commandId === commandId);
        if (opened && isDeepStrictEqual(opened.request, request))
          return { status: 'REPLAYED', canonicalEvents: clone(opened.canonicalEvents) };
        return { status: 'CONFLICT', canonicalEvents: [] };
      }
      if (ep) throw new Error('Episode already exists without checkpoint');
      return openEpisode(client, context, state, sceneId, request);
    });
  }

  async function execute(context, request) {
    requireContext(context);
    if (!request || typeof request.commandId !== 'string' || !request.commandId ||
        !['action','help','presentation','branch'].includes(request.kind)) throw new Error('Invalid S3 request');
    return transaction(async client => {
      const session = await lock(client, context);
      const ep = await episodeRow(client, context);
      if (!ep || !['S2', 'S3'].includes(ep.scene_id)) throw new Error('Actionable episode not found');
      const prior = await latest(client, context);
      if (!prior || prior.source?.format !== FORMAT || prior.source.sceneId !== ep.scene_id)
        throw new Error('No matching scene checkpoint');
      const duplicate = replay(prior, request);
      if (duplicate) return duplicate;
      if ((request.expectedTurn !== undefined || request.kind === 'branch' || ep.scene_id === 'S2') &&
          (session.status !== 'ACTIVE' || session.current_episode_id !== context.episodeId)) {
        return { status: 'REJECTED', canonicalEvents: [] };
      }
      // A start ID cannot be reused with different content or a later command.
      if (prior.source.receipts.some(x => x.commandId === request.commandId))
        return { status: 'CONFLICT', canonicalEvents: [] };
      const source = restoreSource(JSON.stringify(prior.source));
      if (request.expectedTurn !== undefined && request.expectedTurn !== source.state.current.turns) {
        return { status: 'REJECTED', canonicalEvents: [] };
      }
      const selecting = request.kind === 'branch';
      const episode = source.state.current;
      let generated = [];
      if (selecting) {
        if (ep.scene_id !== 'S3' || !episode.done || !['S4A', 'S4B'].includes(request.branch)) {
          return { status: 'REJECTED', canonicalEvents: [] };
        }
      } else {
        if (episode.done) return { status: 'REJECTED', canonicalEvents: [] };
        const result = apply(source, request);
        if (result.status !== 'APPLIED') return result;
        generated = result.canonicalEvents;
      }
      let next;
      if (selecting || (ep.scene_id === 'S2' && source.state.current.done)) {
        const nextState = engine.restore(JSON.stringify(source.state));
        const offer = selecting ? engine.offer(nextState) : undefined;
        engine.next(nextState, request.branch);
        const nextContext = { ...context, episodeId: randomUUID() };
        const destination = { nextEpisodeId: nextContext.episodeId, nextSceneId: nextState.current.id };
        if (selecting) destination.offer = offer;
        generated.push(recordTransition(source, request, destination));
        next = { context: nextContext, state: nextState, sceneId: nextState.current.id };
      }
      const saved = await facts(client, context, source, generated);
      const response = { status: 'APPLIED', canonicalEvents: clone(saved) };
      await client.query('UPDATE nablon_episodes SET turn_index=$2,status=$3 WHERE id=$1',
        [context.episodeId, source.state.current.turns,
          source.state.current.done ? 'COMPLETED' : 'WAITING_RESPONSE']);
      if (prepareReply) await prepareReply(client, context, source.state.current, saved);
      await checkpoint(client, context, request.commandId, request, source, response);
      if (next) {
        const transition = saved.at(-1);
        await openEpisode(client, next.context, next.state, next.sceneId, {
          kind: 'transition', commandId: request.commandId, previousEventId: transition.eventId,
        }, context.episodeId);
      }
      return response;
    });
  }
  async function readSource(context) {
    requireContext(context);
    const r = await pool.query(
      `SELECT payload FROM nablon_events WHERE user_id=$1 AND session_id=$2
       AND episode_id=$3 AND event_name=$4 ORDER BY id DESC LIMIT 1`,
      [context.userId, context.sessionId, context.episodeId, RECEIPT_NAME]);
    if (!r.rows.length) return null;
    return restoreSource(JSON.stringify(r.rows[0].payload.source));
  }
  // This is deliberately a second DB query, not the input packet or a checkpoint.
  // It returns only committed primary facts with their PostgreSQL timestamps.
  async function readPrimaryEvents(context) {
    requireContext(context);
    const r = await pool.query(
      `SELECT payload, occurred_at FROM nablon_events WHERE user_id=$1 AND session_id=$2
       AND episode_id=$3 AND event_name=$4 ORDER BY id ASC`,
      [context.userId, context.sessionId, context.episodeId, EVENT_NAME]);
    return r.rows.map(row => ({ ...row.payload.event, occurredAt: time(row.occurred_at) }));
  }
  return {
    start: (context, state, commandId) => startScene(context, state, commandId, 'S3'),
    startS2: (context, state, commandId) => startScene(context, state, commandId, 'S2'),
    execute, readSource, readPrimaryEvents,
  };
}
module.exports = { createS3Repository, EVENT_NAME, RECEIPT_NAME };
