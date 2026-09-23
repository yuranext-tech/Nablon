-- Nablon runtime schema
-- L0 events are append-only facts. Behavioral interpretation belongs to Becoming.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nablon_sessions (
  id TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  session_number INT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('demo','live')),
  training_id TEXT NOT NULL,
  current_episode_index INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('NOT_STARTED','ACTIVE','COMPLETED','ABANDONED')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS nablon_episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES nablon_sessions(id),
  scene_id TEXT,
  scenario_id TEXT,
  turn_index INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('NOT_STARTED','WAITING_RESPONSE','WAITING_NEW_DECISION','COMPLETED','INCOMPLETE')),
  support_stage TEXT NOT NULL CHECK (support_stage IN ('NONE','DIRECTED')),
  question_requested BOOLEAN NOT NULL DEFAULT FALSE,
  routing_class TEXT CHECK (routing_class IN ('ACTION','EXPLAIN','UNCLEAR')),
  classifier_version TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE nablon_sessions ADD COLUMN IF NOT EXISTS current_episode_id TEXT;
ALTER TABLE nablon_episodes ADD COLUMN IF NOT EXISTS scenario_id TEXT;

CREATE TABLE IF NOT EXISTS nablon_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES nablon_sessions(id),
  episode_id TEXT REFERENCES nablon_episodes(id),
  event_name TEXT NOT NULL,
  turn_index INT NOT NULL,
  set_id TEXT,
  scenario_id TEXT,
  program_version TEXT,
  runtime_version TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Additive compatibility for databases created by earlier revisions.
ALTER TABLE nablon_events ADD COLUMN IF NOT EXISTS set_id TEXT;
ALTER TABLE nablon_events ADD COLUMN IF NOT EXISTS scenario_id TEXT;
ALTER TABLE nablon_events ADD COLUMN IF NOT EXISTS program_version TEXT;
ALTER TABLE nablon_events ADD COLUMN IF NOT EXISTS runtime_version TEXT;
ALTER TABLE nablon_events ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
UPDATE nablon_events SET occurred_at = created_at AT TIME ZONE 'UTC' WHERE occurred_at IS NULL;
ALTER TABLE nablon_events ALTER COLUMN occurred_at SET DEFAULT NOW();
ALTER TABLE nablon_events ALTER COLUMN occurred_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS nablon_processed_updates (
  update_id BIGINT PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nablon_routing_telemetry (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES nablon_sessions(id),
  episode_id TEXT NOT NULL REFERENCES nablon_episodes(id),
  routing_class TEXT NOT NULL CHECK (routing_class IN ('ACTION','EXPLAIN','UNCLEAR')),
  confidence NUMERIC,
  classifier_version TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nablon_outbox (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES nablon_sessions(id),
  episode_id TEXT REFERENCES nablon_episodes(id),
  logical_key TEXT NOT NULL UNIQUE,
  chat_id BIGINT NOT NULL,
  text TEXT NOT NULL,
  reply_markup JSONB,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENDING','SENT')),
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_nablon_outbox_pending
  ON nablon_outbox(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_nablon_outbox_session
  ON nablon_outbox(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nablon_processed_updates_time
  ON nablon_processed_updates(processed_at);
CREATE INDEX IF NOT EXISTS idx_nablon_sessions_user
  ON nablon_sessions(user_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nablon_session_number
  ON nablon_sessions(user_id, session_number);
CREATE INDEX IF NOT EXISTS idx_nablon_episodes_session
  ON nablon_episodes(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_nablon_episodes_scenario
  ON nablon_episodes(scenario_id, started_at);
CREATE INDEX IF NOT EXISTS idx_nablon_events_session
  ON nablon_events(session_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_nablon_events_user
  ON nablon_events(user_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_nablon_events_set_scenario
  ON nablon_events(set_id, scenario_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_nablon_events_program_version
  ON nablon_events(program_version, occurred_at);
CREATE INDEX IF NOT EXISTS idx_nablon_routing_episode
  ON nablon_routing_telemetry(episode_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nablon_one_active_session
  ON nablon_sessions(user_id) WHERE status='ACTIVE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='fk_nablon_current_episode'
  ) THEN
    ALTER TABLE nablon_sessions
      ADD CONSTRAINT fk_nablon_current_episode
      FOREIGN KEY (current_episode_id) REFERENCES nablon_episodes(id);
  END IF;
END $$;

UPDATE nablon_sessions s
SET current_episode_id = x.id
FROM (
  SELECT DISTINCT ON (session_id) id, session_id
  FROM nablon_episodes
  ORDER BY session_id, started_at DESC, id DESC
) x
WHERE s.id=x.session_id
  AND s.current_episode_id IS NULL
  AND s.status='ACTIVE';

ALTER TABLE nablon_sessions ADD COLUMN IF NOT EXISTS session_number INT;
UPDATE nablon_sessions s SET session_number = x.session_number
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY started_at, id) AS session_number
  FROM nablon_sessions
) x
WHERE s.id=x.id AND s.session_number IS NULL;
ALTER TABLE nablon_sessions ALTER COLUMN session_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_nablon_session_number ON nablon_sessions(user_id, session_number);
