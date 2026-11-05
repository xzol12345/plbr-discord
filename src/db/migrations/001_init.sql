-- PL:BR Discord integration - initial schema

-- One row per Roblox account. Totals are ABSOLUTE values copied from the
-- game's saved stats (never increments), so a repeated request can't add
-- anything twice. `revision` only ever moves forward: an older or equal
-- revision is ignored (out-of-order / duplicate safe).
CREATE TABLE IF NOT EXISTS players (
	roblox_user_id   BIGINT PRIMARY KEY CHECK (roblox_user_id > 0),
	roblox_username  TEXT NOT NULL,
	kills            BIGINT NOT NULL DEFAULT 0 CHECK (kills >= 0),
	wins             BIGINT NOT NULL DEFAULT 0 CHECK (wins >= 0),
	deaths           BIGINT NOT NULL DEFAULT 0 CHECK (deaths >= 0),
	kd_ratio         NUMERIC(12, 2) NOT NULL DEFAULT 0,
	revision         BIGINT NOT NULL DEFAULT 0,
	source           TEXT NOT NULL DEFAULT 'game', -- game | opencloud
	last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS players_kills_idx ON players (kills DESC, roblox_user_id);
CREATE INDEX IF NOT EXISTS players_wins_idx ON players (wins DESC, roblox_user_id);

-- Discord <-> Roblox links, confirmed through Bloxlink. Roblox UserId is the
-- permanent identifier; usernames are only display.
CREATE TABLE IF NOT EXISTS links (
	discord_user_id  TEXT PRIMARY KEY,
	roblox_user_id   BIGINT NOT NULL,
	verified_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS links_roblox_idx ON links (roblox_user_id);

-- Every accepted / rejected sync, for auditing (trimmed by the app).
CREATE TABLE IF NOT EXISTS sync_log (
	id               BIGSERIAL PRIMARY KEY,
	roblox_user_id   BIGINT NOT NULL,
	revision         BIGINT NOT NULL,
	outcome          TEXT NOT NULL, -- applied | stale | rejected
	detail           TEXT,
	received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_log_received_idx ON sync_log (received_at);

-- Small key/value store for the bot (leaderboard message ids, etc.)
CREATE TABLE IF NOT EXISTS bot_state (
	key              TEXT PRIMARY KEY,
	value            JSONB NOT NULL,
	updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
