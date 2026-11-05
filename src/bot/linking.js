// Discord <-> Roblox links, always confirmed with Bloxlink. The Roblox UserId
// is the identifier; the username is fetched from Roblox for display.
const db = require('../db/pool');
const bloxlink = require('../services/bloxlink');

// Asks Bloxlink who this Discord member is verified as, and stores it.
// Returns the Roblox UserId, or null if they aren't verified.
async function resolve(discordId, { fresh = false } = {}) {
	const robloxId = await bloxlink.discordToRoblox(discordId, { fresh });
	if (robloxId) {
		await db.query(
			`INSERT INTO links (discord_user_id, roblox_user_id, verified_at) VALUES ($1, $2, now())
			 ON CONFLICT (discord_user_id) DO UPDATE SET roblox_user_id = EXCLUDED.roblox_user_id, verified_at = now()`,
			[discordId, robloxId],
		);
	} else {
		await db.query('DELETE FROM links WHERE discord_user_id = $1', [discordId]);
	}
	return robloxId;
}

// Stored link only (no Bloxlink call)
async function storedRobloxId(discordId) {
	const r = await db.query('SELECT roblox_user_id FROM links WHERE discord_user_id = $1', [discordId]);
	return r.rows[0] ? Number(r.rows[0].roblox_user_id) : null;
}

async function discordIdsFor(robloxId) {
	const r = await db.query('SELECT discord_user_id FROM links WHERE roblox_user_id = $1', [robloxId]);
	return r.rows.map((x) => x.discord_user_id);
}

async function allLinks() {
	return (await db.query('SELECT discord_user_id, roblox_user_id FROM links ORDER BY verified_at ASC')).rows
		.map((r) => ({ discordId: r.discord_user_id, robloxId: Number(r.roblox_user_id) }));
}

module.exports = { resolve, storedRobloxId, discordIdsFor, allLinks };
