import type { CanonicalEvent, Episode } from '../domain/model';
import type { Receipt } from '../application/types';

export interface Repository {
  getEpisode(episodeId: string): Promise<Episode | null>;
  getReceipt(commandId: string): Promise<Receipt | null>;
  saveEpisodeAtomically(
    episode: Episode,
    canonicalEvents: CanonicalEvent[],
    receipt: Receipt,
  ): Promise<void>;
  withEpisodeLock<T>(episodeId: string, operation: () => Promise<T>): Promise<T>;
}

export class InMemoryRepository implements Repository {
  private readonly episodes = new Map<string, Episode>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly events = new Map<string, CanonicalEvent>();
  private readonly locks = new Map<string, Promise<void>>();
  private failAfterMutation = false;

  seedEpisode(episode: Episode): void {
    this.episodes.set(episode.episode_id, clone(episode));
  }

  setFailAfterMutationOnce(): void {
    this.failAfterMutation = true;
  }

  async getEpisode(episodeId: string): Promise<Episode | null> {
    return cloneOrNull(this.episodes.get(episodeId));
  }

  async getReceipt(commandId: string): Promise<Receipt | null> {
    return cloneOrNull(this.receipts.get(commandId));
  }

  async saveEpisodeAtomically(
    episode: Episode,
    canonicalEvents: CanonicalEvent[],
    receipt: Receipt,
  ): Promise<void> {
    const previousEpisode = cloneOrNull(this.episodes.get(episode.episode_id));
    const previousReceipt = cloneOrNull(this.receipts.get(receipt.command_id));
    const previousEvents = new Map(this.events);

    this.episodes.set(episode.episode_id, clone(episode));
    for (const event of canonicalEvents) this.events.set(event.event_id, clone(event));
    this.receipts.set(receipt.command_id, clone(receipt));

    if (this.failAfterMutation) {
      this.failAfterMutation = false;
      if (previousEpisode) this.episodes.set(episode.episode_id, previousEpisode);
      else this.episodes.delete(episode.episode_id);
      if (previousReceipt) this.receipts.set(receipt.command_id, previousReceipt);
      else this.receipts.delete(receipt.command_id);
      this.events.clear();
      for (const [id, event] of previousEvents) this.events.set(id, clone(event));
      throw new Error('injected_atomic_failure');
    }
  }

  async withEpisodeLock<T>(episodeId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(episodeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(episodeId, previous.then(() => current));
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(episodeId) === queued) this.locks.delete(episodeId);
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}
