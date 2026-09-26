import type { CanonicalEvent } from '../domain/model';

export type ApplicationStatus = 'APPLIED' | 'REPLAYED' | 'REJECTED' | 'CONFLICT';

export type ApplicationResult = {
  status: ApplicationStatus;
  command_id: string;
  episode_id: string;
  episode_version: number;
  canonical_events: CanonicalEvent[];
};

export type Receipt = {
  command_id: string;
  result: ApplicationResult;
};
