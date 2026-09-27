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
  /** Monotonic order of this command attempt within its Episode raw trace. */
  trace_sequence: number;
  /** Time at which this command attempt was recorded by R1. */
  occurred_at: string;
};
