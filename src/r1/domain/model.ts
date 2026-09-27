export type EpisodeStatus = 'OPEN' | 'COMPLETED';

export type EpisodeState = {
  phase: 'NEW' | 'ACTIVE' | 'RECONSIDERING' | 'COMPLETED';
  marker: string | null;
};

export type Episode = {
  episode_id: string;
  user_id: string;
  version: number;
  status: EpisodeStatus;
  state: EpisodeState;
  event_ids: string[];
  /** Monotonic raw-attempt order; separate from protocol version and event sequence. */
  trace_sequence: number;
};

export type CommandType =
  | 'OPEN_EPISODE'
  | 'START'
  | 'STOP'
  | 'RECONSIDER'
  | 'CHANGE_APPROACH'
  | 'RECONSIDER_AND_CHANGE_APPROACH'
  | 'COMPLETE';

export type Command = {
  command_id: string;
  episode_id: string;
  expected_version: number;
  type: CommandType;
  payload?: Record<string, unknown>;
};

export type EventDraft = {
  type: string;
  payload: Record<string, unknown>;
};

export type CanonicalEvent = EventDraft & {
  event_id: string;
  episode_id: string;
  sequence: number;
  command_id: string;
  occurred_at: string;
};

export type DomainDecision =
  | { kind: 'APPLIED'; episode: Episode; events: EventDraft[] }
  | { kind: 'REJECTED'; reason: string; episode: Episode };

export const INITIAL_STATE: EpisodeState = { phase: 'NEW', marker: null };

export function createInitialEpisode(episodeId: string, userId: string): Episode {
  return {
    episode_id: episodeId,
    user_id: userId,
    version: 0,
    status: 'OPEN',
    state: { ...INITIAL_STATE },
    event_ids: [],
    trace_sequence: 0,
  };
}

export function reduce(episode: Episode, command: Command): DomainDecision {
  switch (command.type) {
    case 'OPEN_EPISODE':
      return reject(episode, 'episode_already_open');
    case 'START':
      if (episode.state.phase !== 'NEW') return reject(episode, 'start_not_allowed');
      return apply(episode, { phase: 'ACTIVE', marker: null }, [
        { type: 'EPISODE_STARTED', payload: {} },
      ]);
    case 'STOP':
      if (episode.state.phase !== 'ACTIVE') return reject(episode, 'stop_not_allowed');
      return apply(episode, { phase: 'ACTIVE', marker: 'STOPPED' }, [
        { type: 'STOP', payload: {} },
      ]);
    case 'RECONSIDER':
      if (episode.state.marker !== 'STOPPED') return reject(episode, 'reconsider_not_allowed');
      return apply(episode, { phase: 'RECONSIDERING', marker: 'RECONSIDERED' }, [
        { type: 'RECONSIDER', payload: {} },
      ]);
    case 'CHANGE_APPROACH':
      if (episode.state.phase !== 'RECONSIDERING') return reject(episode, 'change_approach_not_allowed');
      return apply(episode, { phase: 'ACTIVE', marker: 'CHANGED_APPROACH' }, [
        { type: 'CHANGE_APPROACH', payload: {} },
      ]);
    case 'RECONSIDER_AND_CHANGE_APPROACH':
      if (episode.state.marker !== 'STOPPED') {
        return reject(episode, 'reconsider_and_change_approach_not_allowed');
      }
      return apply(episode, { phase: 'ACTIVE', marker: 'CHANGED_APPROACH' }, [
        { type: 'RECONSIDER', payload: {} },
        { type: 'CHANGE_APPROACH', payload: {} },
      ]);
    case 'COMPLETE':
      if (episode.state.phase !== 'ACTIVE') return reject(episode, 'complete_not_allowed');
      return apply(episode, { phase: 'COMPLETED', marker: null }, [
        { type: 'EPISODE_COMPLETED', payload: {} },
      ], 'COMPLETED');
  }
}

function apply(
  episode: Episode,
  state: EpisodeState,
  events: EventDraft[],
  status: EpisodeStatus = episode.status,
): DomainDecision {
  return {
    kind: 'APPLIED',
    episode: { ...episode, version: episode.version + 1, status, state },
    events,
  };
}

function reject(episode: Episode, reason: string): DomainDecision {
  return { kind: 'REJECTED', reason, episode };
}
