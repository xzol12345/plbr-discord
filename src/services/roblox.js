// Official Roblox web APIs (public, no key) + Open Cloud (API key, read-only).
const config = require('../config');

async function getJson(url, headers = {}) {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
	if (!res.ok) {
		const err = new Error(`${res.status} from ${new URL(url).host}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// users.roblox.com - current username for a UserId
async function getUser(userId) {
	try {
		const u = await getJson(`https://users.roblox.com/v1/users/${userId}`);
		return { id: Number(u.id), name: u.name, displayName: u.displayName };
	} catch (err) {
		if (err.status === 404) return null;
		throw err;
	}
}

async function getUsers(userIds) {
	if (!userIds.length) return [];
	const res = await fetch('https://users.roblox.com/v1/users', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ userIds, excludeBannedUsers: false }),
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`${res.status} from users.roblox.com`);
	return (await res.json()).data.map((u) => ({ id: Number(u.id), name: u.name, displayName: u.displayName }));
}

// thumbnails.roblox.com - headshot image URL
const avatarCache = new Map();
async function getHeadshotUrl(userId) {
	const hit = avatarCache.get(userId);
	if (hit && Date.now() - hit.at < 30 * 60_000) return hit.url;
	try {
		const r = await getJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
		const url = r.data?.[0]?.state === 'Completed' ? r.data[0].imageUrl : null;
		avatarCache.set(userId, { url, at: Date.now() });
		return url;
	} catch {
		return null;
	}
}

function profileUrl(userId) {
	return `https://www.roblox.com/users/${userId}/profile`;
}

// ---------------------------------------------------------------- Open Cloud
function openCloudHeaders() {
	return { 'x-api-key': config.robloxOpenCloudKey };
}

// Pulls a nested field out of the saved entry with a dotted path ("stats.kills").
function pick(obj, dotted) {
	return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Reads a player's SAVED stats entry (read-only). Field paths are set in
// statsFields (filled in from the game's actual data layout).
async function readSavedStats(userId, statsFields) {
	if (!config.openCloudEnabled || !config.statsDataStore) return null;
	const entry = config.statsEntryKeyFormat.replace('{userId}', String(userId));
	const url = `https://apis.roblox.com/cloud/v2/universes/${config.robloxUniverseId}/data-stores/${encodeURIComponent(config.statsDataStore)}`
		+ `/scopes/${encodeURIComponent(config.statsDataStoreScope)}/entries/${encodeURIComponent(entry)}`;
	let body;
	try {
		body = await getJson(url, openCloudHeaders());
	} catch (err) {
		if (err.status === 404) return null; // never saved
		throw err;
	}
	const v = body.value;
	if (v == null) return null;
	const out = {};
	for (const [key, path] of Object.entries(statsFields)) {
		const n = Number(path ? pick(v, path) : undefined);
		out[key] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
	}
	return out;
}

// Top entries of an ORDERED data store (the game's global leaderboards).
async function listOrdered(storeName, limit = 25) {
	if (!config.openCloudEnabled || !storeName) return [];
	const url = new URL(`https://apis.roblox.com/cloud/v2/universes/${config.robloxUniverseId}/ordered-data-stores/${encodeURIComponent(storeName)}`
		+ `/scopes/${encodeURIComponent(config.orderedDataStoreScope)}/entries`);
	url.searchParams.set('maxPageSize', String(limit));
	url.searchParams.set('orderBy', 'value desc');
	const body = await getJson(url.toString(), openCloudHeaders());
	const list = body.orderedDataStoreEntries || body.entries || [];
	return list.map((e) => ({ key: String(e.id ?? String(e.path || '').split('/').pop()), value: Number(e.value) || 0 }));
}

module.exports = { getUser, getUsers, getHeadshotUrl, profileUrl, readSavedStats, listOrdered };
