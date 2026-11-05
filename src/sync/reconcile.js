// Reconciliation: catches anything a live push missed (API was down, a
// server crashed before it could send, a player hasn't played since the
// bot went up). Uses Roblox Open Cloud to READ the game's saved data -
// read-only keys, nothing in the game is ever written from here.
const config = require('../config');
const roblox = require('../services/roblox');
const store = require('../stats/store');

function fieldsConfigured() {
	const f = config.statsFields;
	return Boolean(f.kills && f.wins && f.deaths);
}

// Re-reads one player's saved totals and stores them (authoritative).
// Returns the player, or null if Open Cloud isn't set up / nothing saved.
async function refreshFromOpenCloud(robloxId) {
	if (!config.openCloudEnabled || !config.statsDataStore || !fieldsConfigured()) return null;
	const saved = await roblox.readSavedStats(robloxId, config.statsFields);
	if (!saved) return null;
	const user = await roblox.getUser(robloxId);
	if (!user) return null;
	await store.applyUpdate({
		userId: robloxId,
		username: user.name,
		kills: saved.kills,
		wins: saved.wins,
		deaths: saved.deaths,
		revision: 1, // Open Cloud never advances the game's revision (kept via GREATEST)
	}, 'opencloud');
	return store.getPlayer(robloxId);
}

// Pulls the top of the game's existing global leaderboards (ordered data
// stores) so the Discord leaderboards include players who haven't played
// since the bot went online. Each name is then refreshed from saved data.
async function backfillTopPlayers(limit = 15) {
	if (!config.openCloudEnabled) return 0;
	const ids = new Set();
	for (const storeName of [config.killsOrderedDataStore, config.winsOrderedDataStore]) {
		if (!storeName) continue;
		try {
			for (const e of await roblox.listOrdered(storeName, limit)) {
				const id = Number(String(e.key).replace(/\D/g, ''));
				if (Number.isSafeInteger(id) && id > 0) ids.add(id);
			}
		} catch (err) {
			console.warn(`[reconcile] ordered store ${storeName}: ${err.message}`);
		}
	}
	let n = 0;
	for (const id of ids) {
		try {
			if (await refreshFromOpenCloud(id)) n++;
		} catch (err) {
			console.warn(`[reconcile] ${id}: ${err.message}`);
		}
		await new Promise((r) => setTimeout(r, 250)); // stay well inside Open Cloud limits
	}
	return n;
}

module.exports = { refreshFromOpenCloud, backfillTopPlayers, fieldsConfigured };
