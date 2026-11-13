CREATE TABLE IF NOT EXISTS nablon_orientation_episodes (
  id uuid PRIMARY KEY,
  owner_ref text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  active boolean NOT NULL,
  state jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS nablon_orientation_one_active
  ON nablon_orientation_episodes(owner_ref) WHERE active;

CREATE TABLE IF NOT EXISTS nablon_orientation_events (
  episode_id uuid NOT NULL REFERENCES nablon_orientation_episodes(id),
  sequence integer NOT NULL CHECK (sequence >= 1),
  episode_version integer NOT NULL CHECK (episode_version >= 1),
  command_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fact jsonb NOT NULL,
  PRIMARY KEY (episode_id, sequence)
);

CREATE TABLE IF NOT EXISTS nablon_orientation_receipts (
  owner_ref text NOT NULL,
  command_id text NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (owner_ref, command_id)
);
