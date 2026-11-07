-- Server Booster rewards (Boost FAL + Boost AA-12). One row per Discord
-- member who has been seen boosting. Discord's own boost status
-- (premium_since / the Server Booster role) is the source of truth for
-- eligibility; this table only remembers what has been done:
--   roblox_user_id  the linked account the reward goes to (Roblox UserId)
--   granted_*       set once the GAME confirmed the items are in that
--                   account's inventory - never granted twice
CREATE TABLE IF NOT EXISTS boost_rewards (
	discord_user_id        TEXT PRIMARY KEY,
	roblox_user_id         BIGINT,
	first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_seen_boosting_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	dm_sent_at             TIMESTAMPTZ,
	dm_failed_at           TIMESTAMPTZ,
	granted_roblox_user_id BIGINT,
	granted_at             TIMESTAMPTZ
);
-- one reward per Roblox account, whichever Discord member it came from
CREATE UNIQUE INDEX IF NOT EXISTS boost_rewards_granted_once ON boost_rewards (granted_roblox_user_id) WHERE granted_roblox_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS boost_rewards_pending ON boost_rewards (roblox_user_id) WHERE granted_at IS NULL AND roblox_user_id IS NOT NULL;
