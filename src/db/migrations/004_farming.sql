-- Stat farming / alt farming detection: server-authoritative events from the
-- game (match starts, eliminations, wins, play sessions) + stat snapshots.
-- Kept for FARM_RETENTION_DAYS (default 30) and trimmed daily.
CREATE TABLE IF NOT EXISTS farm_matches (
	match_id      TEXT PRIMARY KEY,
	server_id     TEXT,
	mode          TEXT,
	player_count  INT NOT NULL DEFAULT 0,
	started_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS farm_matches_time ON farm_matches (started_at);

CREATE TABLE IF NOT EXISTS farm_match_players (
	match_id  TEXT NOT NULL,
	user_id   BIGINT NOT NULL,
	team_id   INT NOT NULL DEFAULT 0,
	PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS farm_match_players_user ON farm_match_players (user_id);

CREATE TABLE IF NOT EXISTS farm_kills (
	id           BIGSERIAL PRIMARY KEY,
	event_id     TEXT UNIQUE,                 -- the game's id for this kill: a resent batch can't double-count
	match_id     TEXT,
	killer_id    BIGINT NOT NULL,
	victim_id    BIGINT NOT NULL,
	same_team    BOOLEAN NOT NULL DEFAULT false,
	at           TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS farm_kills_pair ON farm_kills (killer_id, victim_id, at);
CREATE INDEX IF NOT EXISTS farm_kills_victim ON farm_kills (victim_id, at);
CREATE INDEX IF NOT EXISTS farm_kills_time ON farm_kills (at);

CREATE TABLE IF NOT EXISTS farm_wins (
	match_id  TEXT NOT NULL,
	user_id   BIGINT NOT NULL,
	at        TIMESTAMPTZ NOT NULL,
	PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS farm_wins_user ON farm_wins (user_id, at);

CREATE TABLE IF NOT EXISTS farm_sessions (
	event_id   TEXT PRIMARY KEY,
	user_id    BIGINT NOT NULL,
	joined_at  TIMESTAMPTZ NOT NULL,
	seconds    INT NOT NULL
);
CREATE INDEX IF NOT EXISTS farm_sessions_user ON farm_sessions (user_id, joined_at);

-- latest name + account age per player (display + "young account" checks)
CREATE TABLE IF NOT EXISTS farm_players (
	user_id      BIGINT PRIMARY KEY,
	name         TEXT NOT NULL,
	account_age  INT,
	updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- saved totals over time (from the stats sync) for "big jump in a short time"
CREATE TABLE IF NOT EXISTS farm_stat_snapshots (
	user_id  BIGINT NOT NULL,
	kills    BIGINT NOT NULL,
	wins     BIGINT NOT NULL,
	deaths   BIGINT NOT NULL,
	at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_snapshots_user ON farm_stat_snapshots (user_id, at);

-- one row per ongoing incident: its Discord message is EDITED as it grows
CREATE TABLE IF NOT EXISTS farm_incidents (
	key          TEXT PRIMARY KEY,
	kind         TEXT NOT NULL,
	user_id      BIGINT NOT NULL,
	severity     TEXT NOT NULL,
	score        INT NOT NULL,
	summary      TEXT NOT NULL,
	details      JSONB NOT NULL,
	message_id   TEXT,
	channel_id   TEXT,
	first_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
