// Server Booster rewards - the database side. The bot decides WHO is boosting
// (Discord's own boost status); the game asks for its online players'
// pending rewards, grants the items through its inventory system and
// confirms. Nothing is ever granted twice:
//   * a Discord member's reward is granted at most once
//   * a Roblox account receives it at most once (unique index)
//   * the game also skips items the account already owns
// Eligibility is re-checked with Discord (verifier) at the moment the game
// asks - someone who stopped boosting before playing doesn't get it.
const db = require('../db/pool');

const KIND = 'boost';
let verifier = null; // async (discordId) -> true | false | null (unknown)

function setVerifier(fn) { verifier = fn; }

// A member is boosting right now. Records them (first time = new booster).
// robloxId: their linked Roblox UserId, or null. Returns the row + isNew.
async function recordBooster(discordId, robloxId) {
	const r = await db.query(
		`INSERT INTO boost_rewards (discord_user_id, roblox_user_id) VALUES ($1, $2)
		 ON CONFLICT (discord_user_id) DO UPDATE SET
		   last_seen_boosting_at = now(),
		   -- the reward goes to their CURRENT link until it's granted; after that it's fixed
		   roblox_user_id = CASE WHEN boost_rewards.granted_at IS NULL THEN COALESCE(EXCLUDED.roblox_user_id, boost_rewards.roblox_user_id) ELSE boost_rewards.roblox_user_id END
		 RETURNING *, (xmax = 0) AS inserted`,
		[discordId, robloxId || null],
	);
	return { row: r.rows[0], isNew: r.rows[0].inserted === true };
}

async function markDm(discordId, ok) {
	await db.query(`UPDATE boost_rewards SET ${ok ? 'dm_sent_at' : 'dm_failed_at'} = now() WHERE discord_user_id = $1`, [discordId]);
}

async function get(discordId) {
	return (await db.query('SELECT * FROM boost_rewards WHERE discord_user_id = $1', [discordId])).rows[0] || null;
}

// The game asks: which of these Roblox accounts have a reward waiting?
// Only rows whose member is STILL boosting (verified with Discord) count.
async function pendingFor(robloxIds) {
	if (!robloxIds.length || !verifier) return [];
	const r = await db.query(
		`SELECT b.* FROM boost_rewards b
		 WHERE b.granted_at IS NULL AND b.roblox_user_id = ANY($1::bigint[])
		   AND NOT EXISTS (SELECT 1 FROM boost_rewards g WHERE g.granted_roblox_user_id = b.roblox_user_id)`,
		[robloxIds],
	);
	const out = [];
	for (const row of r.rows) {
		let boosting = null;
		try { boosting = await verifier(row.discord_user_id); } catch { boosting = null; }
		if (boosting === true) out.push({ id: row.discord_user_id, kind: KIND, userId: Number(row.roblox_user_id) });
	}
	return out;
}

// The game confirms the items are in the inventory. Idempotent: a retried
// confirmation is fine, and it can never move the reward to another account.
// Returns { ok, newly } - newly = this call recorded the grant.
async function confirmGranted(discordId, robloxId) {
	try {
		const r = await db.query(
			`UPDATE boost_rewards SET granted_at = now(), granted_roblox_user_id = $2
			 WHERE discord_user_id = $1 AND roblox_user_id = $2 AND granted_at IS NULL RETURNING *`,
			[discordId, robloxId],
		);
		if (r.rows[0]) return { ok: true, newly: true, row: r.rows[0] };
	} catch (err) {
		if (err.code !== '23505') throw err; // 23505: that Roblox account already got it via another member
		return { ok: true, newly: false };
	}
	const row = await get(discordId);
	return { ok: Boolean(row && Number(row.granted_roblox_user_id) === robloxId), newly: false, row };
}

module.exports = { KIND, setVerifier, recordBooster, markDm, get, pendingFor, confirmGranted };
