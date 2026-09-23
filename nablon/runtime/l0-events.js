// L0 event writer for the Nablon runtime.
// This module records immutable observations only. It must not interpret behavior.

async function recordL0Event({
  client,
  event_name,
  user_id,
  session_id,
  episode_id = null,
  set_id = null,
  scenario_id = null,
  turn_index = 0,
  program_version,
  runtime_version,
  payload = {},
}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client with query() is required');
  if (!event_name) throw new TypeError('event_name is required');
  if (user_id == null) throw new TypeError('user_id is required');
  if (!session_id) throw new TypeError('session_id is required');
  if (!program_version) throw new TypeError('program_version is required');
  if (!runtime_version) throw new TypeError('runtime_version is required');
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('payload must be an object');
  }

  const result = await client.query(
    `INSERT INTO nablon_events
      (user_id, session_id, episode_id, event_name, turn_index,
       set_id, scenario_id, program_version, runtime_version, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     RETURNING id, occurred_at`,
    [
      user_id,
      session_id,
      episode_id,
      event_name,
      turn_index,
      set_id,
      scenario_id,
      program_version,
      runtime_version,
      JSON.stringify(payload),
    ]
  );

  return result.rows[0];
}

module.exports = { recordL0Event };
