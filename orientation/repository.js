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
        if (!isDeepStrictEqual(previous.request, request)) {
          result = { status: 'CONFLICT' };
        } else {
          result = { ...previous.result, status: 'REPLAYED', originalStatus: previous.result.status };
          if (previous.result.episode) {
            result.presentation = await findEpisode(client, owner, previous.result.episode.id);
          }
        }
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

  function snapshot(row) {
    return { id: row.id, version: row.version, state: row.state };
  }

  async function findEpisode(client, owner, episodeId) {
    const { rows } = await client.query(
      'SELECT * FROM nablon_orientation_episodes WHERE owner_ref=$1 AND id=$2', [owner, episodeId],
    );
    return rows[0] ?? null;
  }

  async function apply(client, owner, commandId, request) {
    const { action, episodeId } = request;
    let previous;
    if (episodeId) {
      previous = await findEpisode(client, owner, episodeId);
    } else {
      const active = await client.query('SELECT * FROM nablon_orientation_episodes WHERE owner_ref=$1 AND active', [owner]);
      previous = active.rows[0];
      if (action === 'start' && !previous) {
        const last = await client.query(
          `SELECT e.* FROM nablon_orientation_episodes e
           JOIN nablon_orientation_events opened ON opened.episode_id=e.id AND opened.sequence=1
           WHERE e.owner_ref=$1 ORDER BY opened.occurred_at DESC, e.id DESC LIMIT 1`,
          [owner],
        );
        previous = last.rows[0];
      }
    }

    const opening = action === 'start' || action === 'restart';
    if (action === 'restart' && previous?.active) {
      await client.query('UPDATE nablon_orientation_episodes SET active=false WHERE id=$1', [previous.id]);
      previous = null;
    }
    if (opening && previous) {
      return { status: 'RESUMED', episode: snapshot(previous) };
    }

    let episode, events;
    if (opening) {
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
      if (!previous) return { status: 'REJECTED' };
      if (episodeId && (!previous.active || request.version !== previous.version)) {
        return { status: 'CONFLICT', version: previous.version, episode: snapshot(previous) };
      }
      if (!previous.active) return { status: 'REJECTED' };
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

  async function recordSent(owner, episode, commandId, method) {
    await pool.query(
      `INSERT INTO nablon_orientation_telegram_sends(episode_id,episode_version,command_id,method)
       SELECT id,$3,$4,$5 FROM nablon_orientation_episodes WHERE owner_ref=$1 AND id=$2`,
      [owner, episode.id, episode.version, commandId, method],
    );
  }

  return { execute, recordSent };
}

module.exports = { createRepository };
