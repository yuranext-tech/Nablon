-- Probe Library v0 / Layer A schema
-- Принцип: только детерминированные события. Никакой семантики, никакого EIG.
-- target_core — свободная метка для будущей сортировки, НЕ формальная сущность Semantic Registry.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    state TEXT NOT NULL DEFAULT 'NEW',
        -- NEW | ACTIVE | WAITING_OUTCOME | READY_FOR_NEXT | INACTIVE | DORMANT
    preferred_slot_hour INT DEFAULT 20,
    preferred_slot_minute INT DEFAULT 0,
    timezone TEXT DEFAULT 'Europe/Kiev',
    safety_flags TEXT[] DEFAULT '{}',
    last_probe_code TEXT,
    consecutive_no_response INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    last_active_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS probes (
    id SERIAL PRIMARY KEY,
    probe_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    target_core TEXT NOT NULL,          -- метка, не FK, не Semantic Registry
    payload_day TEXT NOT NULL,
    payload_evening TEXT,
    fields_schema JSONB NOT NULL,
    event_day TEXT NOT NULL,
    event_evening TEXT,
    completion_burden TEXT CHECK (completion_burden IN ('low','medium','high')),
    active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS observations (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    probe_id INT REFERENCES probes(id),
    probe_code TEXT NOT NULL,           -- денормализовано для скорости выборок

    friction_context TEXT,              -- свободный текст, если пользователь его дал
    intervention_payload JSONB,         -- что отправил бот
    response_payload JSONB,             -- сырой ответ пользователя

    structured_fields JSONB,            -- нормализованные поля, напр. {"predicted_value":8}

    event_type TEXT NOT NULL,           -- PREDICTION_MADE | PREDICTION_RESOLVED | CHOICE_MADE | ...
    event_phase TEXT CHECK (event_phase IN ('day','evening','followup')),

    response_latency_seconds INT,
    rolling_avg_latency FLOAT,

    created_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP,

    is_valid BOOLEAN DEFAULT TRUE,
    invalid_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_observations_user_probe ON observations(user_id, probe_id);
CREATE INDEX IF NOT EXISTS idx_observations_event ON observations(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_user_core ON observations(user_id, probe_code);
CREATE INDEX IF NOT EXISTS idx_users_state ON users(state);
