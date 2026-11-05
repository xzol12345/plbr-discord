// Bloxlink public API (v4), using a SERVER API key from the Bloxlink dashboard
// for your Discord server. Only the officially documented lookups are used:
//   GET https://api.blox.link/v4/public/guilds/{guildId}/discord-to-roblox/{discordId}
//   GET https://api.blox.link/v4/public/guilds/{guildId}/roblox-to-discord/{robloxId}
// Header: Authorization: <server API key>. The basic response carries
// `robloxID` / `discordIDs`; anything richer ("resolved") needs Bloxlink
// premium, so we never depend on it - usernames come from Roblox itself.
const config = require('../config');

const BASE = 'https://api.blox.link/v4/public';
const cache = new Map(); // discordId -> { robloxId, at }
const CACHE_MS = 5 * 60_000;

class BloxlinkError extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
	}
}

async function call(path) {
	if (!config.bloxlinkApiKey) throw new BloxlinkError('BLOXLINK_API_KEY is not set', 0);
	const res = await fetch(`${BASE}${path}`, {
		headers: { Authorization: config.bloxlinkApiKey },
		signal: AbortSignal.timeout(8000),
	});
	let body = {};
	try { body = await res.json(); } catch { /* non-json */ }
	return { status: res.status, body };
}

// -> Roblox UserId (number) or null if the member hasn't verified.
async function discordToRoblox(discordId, { fresh = false } = {}) {
	const hit = cache.get(discordId);
	if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.robloxId;
	const { status, body } = await call(`/guilds/${config.discordGuildId}/discord-to-roblox/${discordId}`);
	if (status === 404 || (body && body.error && /not (verified|linked)|unknown/i.test(String(body.error)))) {
		cache.set(discordId, { robloxId: null, at: Date.now() });
		return null;
	}
	if (status === 401 || status === 403) throw new BloxlinkError('Bloxlink rejected the API key (check BLOXLINK_API_KEY and that it belongs to this server)', status);
	if (status === 429) throw new BloxlinkError('Bloxlink rate limit - try again shortly', status);
	if (status < 200 || status >= 300) throw new BloxlinkError(`Bloxlink error ${status}: ${body?.error || 'unknown'}`, status);
	const id = Number(body.robloxID ?? body.robloxId);
	const robloxId = Number.isSafeInteger(id) && id > 0 ? id : null;
	cache.set(discordId, { robloxId, at: Date.now() });
	return robloxId;
}

// -> array of Discord ids verified to this Roblox account (in this server).
async function robloxToDiscord(robloxId) {
	const { status, body } = await call(`/guilds/${config.discordGuildId}/roblox-to-discord/${robloxId}`);
	if (status === 404) return [];
	if (status < 200 || status >= 300) throw new BloxlinkError(`Bloxlink error ${status}: ${body?.error || 'unknown'}`, status);
	const ids = body.discordIDs ?? body.discordIds ?? [];
	return Array.isArray(ids) ? ids.map(String) : [];
}

module.exports = { discordToRoblox, robloxToDiscord, BloxlinkError };
