const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { VERSION, INTRO, initialState, advance } = require('./episode');

function createRepository(pool) {
  async function execute(owner, commandId, request) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // All writes for this owner, including opening a scene, use one lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['orientation:' + owner]);
      const receipt = await client.query(
        'SELECT request, result FROM nablon_orientation_receipts WHERE owner_ref = $1 AND command_id = $2',
        [owner, commandId],
      );
      let result;
      if (receipt.rowCount) {
        const previous = receipt.rows[0];
        result = isDeepStrictEqual(previous.request, request)
          ? { ...previous.result, status: 'REPLAYED', originalStatus: previous.result.status }
          : { status: 'CONFLICT' };
      } else {
        result = await apply(client, owner, commandId, request);
        await client.query(
          'INSERT INTO nablon_orientation_receipts(owner_ref, command_id, request, result) VALUES ($1,$2,$3,$4)',
          [owner, commandId, request, result],
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* The original error is more useful. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async function apply(client, owner, commandId, request) {
    const lookup = request.episodeId
      ? await client.query('SELECT * FROM nablon_orientation_episodes WHERE owner_ref=$1 AND id=$2', [owner, request.episodeId])
      : await client.query('SELECT * FROM nablon_orientation_episodes WHERE owner_ref=$1 AND active', [owner]);
    const previous = lookup.rows[0];
    if (request.action === 'start' && previous) {
      return { status: 'RESUMED', episode: { id: previous.id, version: previous.version, state: previous.state } };
    }

    let episode, events;
    if (request.action === 'start') {
      episode = { id: randomUUID(), version: 1, state: initialState() };
      events = [
        { type: 'EPISODE_OPENED', sceneVersion: VERSION },
        { type: 'SCENARIO_PREPARED', message: INTRO },
      ];
      await client.query(
        'INSERT INTO nablon_orientation_episodes(id,owner_ref,version,active,state) VALUES ($1,$2,$3,true,$4)',
        [episode.id, owner, episode.version, episode.state],
      );
    } else {
      if (!previous || !previous.active) return { status: 'REJECTED' };
      if (request.episodeId && request.version !== previous.version) {
        return { status: 'CONFLICT', version: previous.version };
      }
      const change = advance(previous.state, request.action, previous.version);
      if (!change) return { status: 'REJECTED' };
      episode = { id: previous.id, version: previous.version + 1, state: change.state };
      events = change.events;
      await client.query(
        'UPDATE nablon_orientation_episodes SET version=$2, active=$3, state=$4 WHERE id=$1',
        [episode.id, episode.version, episode.state.goal === 'pending', episode.state],
      );
    }

    const { rows } = await client.query(
      'SELECT COALESCE(MAX(sequence), 0) AS last FROM nablon_orientation_events WHERE episode_id=$1',
      [episode.id],
    );
    let sequence = rows[0].last;
    const canonicalEvents = [];
    for (const fact of events) {
      const { rows: inserted } = await client.query(
        'INSERT INTO nablon_orientation_events(episode_id,sequence,episode_version,command_id,fact) VALUES ($1,$2,$3,$4,$5) RETURNING occurred_at',
        [episode.id, ++sequence, episode.version, commandId, fact],
      );
      canonicalEvents.push({
        ...fact, eventId: episode.id + ':' + sequence, episodeId: episode.id, commandId,
        sequence, occurredAt: inserted[0].occurred_at.toISOString(),
      });
    }
    return { status: 'APPLIED', episode, canonicalEvents };
  }

  return { execute };
}

module.exports = { createRepository };
