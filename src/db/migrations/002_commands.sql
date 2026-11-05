-- Commands from Discord for the game to carry out (e.g. /ban). Game servers
-- poll and CLAIM them atomically, so exactly one server runs each command.
CREATE TABLE IF NOT EXISTS game_commands (
	id            BIGSERIAL PRIMARY KEY,
	kind          TEXT NOT NULL,
	payload       JSONB NOT NULL,
	status        TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | done | failed
	attempts      INT NOT NULL DEFAULT 0,
	claimed_by    TEXT,
	claimed_at    TIMESTAMPTZ,
	result        JSONB,
	requested_by  TEXT NOT NULL,
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
	finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS game_commands_open ON game_commands (status, id) WHERE status IN ('pending', 'claimed');
