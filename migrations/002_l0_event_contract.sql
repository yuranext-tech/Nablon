-- Nablon L0 event contract v0.1
-- Additive migration: preserve legacy nablon_events while adding stable
-- provenance/version fields required by the new runtime.

ALTER TABLE nablon_events
  ADD COLUMN IF NOT EXISTS set_id TEXT,
  ADD COLUMN IF NOT EXISTS scenario_id TEXT,
  ADD COLUMN IF NOT EXISTS program_version TEXT,
  ADD COLUMN IF NOT EXISTS runtime_version TEXT,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;

-- Existing created_at values become the historical occurred_at value.
UPDATE nablon_events
SET occurred_at = created_at AT TIME ZONE 'UTC'
WHERE occurred_at IS NULL;

ALTER TABLE nablon_events
  ALTER COLUMN occurred_at SET DEFAULT NOW();

ALTER TABLE nablon_events
  ALTER COLUMN occurred_at SET NOT NULL;

-- Keep created_at for backward compatibility with the existing runtime.
-- New runtime code should use occurred_at as the event timestamp.
CREATE INDEX IF NOT EXISTS idx_nablon_events_episode_order
  ON nablon_events(episode_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS idx_nablon_events_set_scenario
  ON nablon_events(set_id, scenario_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_nablon_events_program_version
  ON nablon_events(program_version, occurred_at);
