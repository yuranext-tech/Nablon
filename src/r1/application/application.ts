import { createInitialEpisode, reduce } from '../domain/model';
import type { CanonicalEvent, Command, Episode } from '../domain/model';
import type { ApplicationResult, Receipt } from './types';
import type { Repository } from '../repository/repository';

export class Application {
  constructor(
    private readonly repository: Repository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly makeId: () => string = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  ) {}

  async openEpisode(episodeId: string, userId: string, commandId: string): Promise<ApplicationResult> {
    const existing = await this.repository.getEpisode(episodeId);
    if (existing) throw new Error('episode_already_exists');
    const episode = createInitialEpisode(episodeId, userId);
    const event: CanonicalEvent = {
      event_id: this.makeId(),
      episode_id: episodeId,
      sequence: 1,
      command_id: commandId,
      type: 'EPISODE_OPENED',
      payload: {},
      occurred_at: this.now(),
    };
    const result: ApplicationResult = {
      status: 'APPLIED',
      command_id: commandId,
      episode_id: episodeId,
      episode_version: episode.version,
      canonical_events: [event],
    };
    await this.repository.withEpisodeLock(episodeId, async () => {
      if (await this.repository.getEpisode(episodeId)) throw new Error('episode_already_exists');
      await this.repository.saveEpisodeAtomically(
        { ...episode, version: 1, event_ids: [event.event_id] },
        [event],
        { command_id: commandId, result: { ...result, episode_version: 1 } },
      );
    });
    return { ...result, episode_version: 1 };
  }

  async execute(command: Command): Promise<ApplicationResult> {
    return this.repository.withEpisodeLock(command.episode_id, async () => {
      const existingReceipt = await this.repository.getReceipt(command.command_id);
      if (existingReceipt) return replay(existingReceipt.result);

      const episode = await this.repository.getEpisode(command.episode_id);
      if (!episode) throw new Error('episode_not_found');

      if (episode.version !== command.expected_version) {
        return {
          status: 'CONFLICT',
          command_id: command.command_id,
          episode_id: command.episode_id,
          episode_version: episode.version,
          canonical_events: [],
        };
      }

      const decision = reduce(episode, command);
      if (decision.kind === 'REJECTED') {
        const result: ApplicationResult = {
          status: 'REJECTED',
          command_id: command.command_id,
          episode_id: command.episode_id,
          episode_version: episode.version,
          canonical_events: [],
        };
        await this.repository.saveEpisodeAtomically(
          episode,
          [],
          { command_id: command.command_id, result },
        );
        return result;
      }

      const events = decision.events.map((draft, index) => ({
        ...draft,
        event_id: this.makeId(),
        episode_id: command.episode_id,
        sequence: episode.event_ids.length + index + 1,
        command_id: command.command_id,
        occurred_at: this.now(),
      }));
      const nextEpisode: Episode = {
        ...decision.episode,
        event_ids: [...episode.event_ids, ...events.map((event) => event.event_id)],
      };
      const result: ApplicationResult = {
        status: 'APPLIED',
        command_id: command.command_id,
        episode_id: command.episode_id,
        episode_version: nextEpisode.version,
        canonical_events: events,
      };
      const receipt: Receipt = { command_id: command.command_id, result };
      await this.repository.saveEpisodeAtomically(nextEpisode, events, receipt);
      return result;
    });
  }
}

function replay(result: ApplicationResult): ApplicationResult {
  return {
    ...result,
    status: 'REPLAYED',
    canonical_events: result.canonical_events.map((event) => ({ ...event, payload: { ...event.payload } })),
  };
}
