CREATE TABLE IF NOT EXISTS recommendation_runs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  local_memory JSONB NOT NULL DEFAULT '{}'::jsonb,
  hermes_response JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS watch_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  service TEXT,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT
);

CREATE TABLE IF NOT EXISTS saved_titles (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  title TEXT NOT NULL,
  service TEXT,
  type TEXT,
  status TEXT NOT NULL DEFAULT 'saved',
  mood_tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  UNIQUE (title, service)
);

CREATE TABLE IF NOT EXISTS preference_memory (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'dashboard',
  memory_text TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
