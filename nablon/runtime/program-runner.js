const crypto = require('crypto');
const { getProbe } = require('../program/model');
const { recordL0Event } = require('./l0-events');

const RUNTIME_VERSION = 'nablon-runtime-v0.3';

function newId(prefix) { return prefix + '_' + crypto.randomUUID(); }

async function startSet({ client, user, set }) {
  const sessionId = newId('ses');
  const episodeId = newId('ep');
  const first = getProbe(set, 0);

  await client.query('BEGIN');
  try {
    const n = (await client.query(
      'SELECT COALESCE(MAX(session_number),0)+1 AS session_number FROM nablon_sessions WHERE user_id=$1',
      [user.id]
    )).rows[0].session_number;

    await client.query(
      "INSERT INTO nablon_sessions (id,user_id,session_number,mode,training_id,current_episode_index,status) VALUES ($1,$2,$3,'live',$4,0,'ACTIVE')",
      [sessionId, user.id, n, set.id]
    );

    await client.query(
      "INSERT INTO nablon_episodes (id,session_id,scene_id,turn_index,status,support_stage) VALUES ($1,$2,$3,0,'WAITING_RESPONSE','NONE')",
      [episodeId, sessionId, first.id]
    );

    await recordL0Event({
      client, event_name: 'SESSION_STARTED', user_id: user.id, session_id: sessionId,
      episode_id: episodeId, set_id: set.id, scenario_id: first.id, turn_index: 0,
      program_version: set.programVersion, runtime_version: RUNTIME_VERSION,
      payload: { set_type: set.type },
    });

    await recordL0Event({
      client, event_name: 'EPISODE_STARTED', user_id: user.id, session_id: sessionId,
      episode_id: episodeId, set_id: set.id, scenario_id: first.id, turn_index: 0,
      program_version: set.programVersion, runtime_version: RUNTIME_VERSION,
      payload: {},
    });

    await recordL0Event({
      client, event_name: 'PROBE_PRESENTED', user_id: user.id, session_id: sessionId,
      episode_id: episodeId, set_id: set.id, scenario_id: first.id, turn_index: 0,
      program_version: set.programVersion, runtime_version: RUNTIME_VERSION,
      payload: { prompt: first.prompt, kind: first.kind, domain: first.domain },
    });

    await client.query('UPDATE nablon_sessions SET current_episode_id=$1 WHERE id=$2', [episodeId, sessionId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  return { sessionId, episodeId, probe: first };
}

async function startNextEpisode({ client, user, session, index, set }) {
  const probe = getProbe(set, index);
  if (!probe) return null;
  const episodeId = newId('ep');

  await client.query('BEGIN');
  try {
    await client.query(
      "INSERT INTO nablon_episodes (id,session_id,scene_id,turn_index,status,support_stage) VALUES ($1,$2,$3,0,'WAITING_RESPONSE','NONE')",
      [episodeId, session.id, probe.id]
    );
    await recordL0Event({
      client, event_name: 'EPISODE_STARTED', user_id: user.id, session_id: session.id,
      episode_id: episodeId, set_id: set.id, scenario_id: probe.id, turn_index: 0,
      program_version: set.programVersion, runtime_version: RUNTIME_VERSION, payload: {},
    });
    await recordL0Event({
      client, event_name: 'PROBE_PRESENTED', user_id: user.id, session_id: session.id,
      episode_id: episodeId, set_id: set.id, scenario_id: probe.id, turn_index: 0,
      program_version: set.programVersion, runtime_version: RUNTIME_VERSION,
      payload: { prompt: probe.prompt, kind: probe.kind, domain: probe.domain },
    });
    await client.query('UPDATE nablon_sessions SET current_episode_index=$1,current_episode_id=$2 WHERE id=$3', [index, episodeId, session.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  return { episodeId, probe };
}

module.exports = { RUNTIME_VERSION, startSet, startNextEpisode };
