const db = require('../db/pool');
const { kdRatio } = require('./kd');
const events = require('../events');

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MAX_STAT = 1_000_000_000;

function isStat(n) {
	return Number.isSafeInteger(n) && n >= 0 && n <= MAX_STAT;
}

// Validates one update from a game server. Returns { ok, value | error }.
function validateUpdate(u) {
	if (!u || typeof u !== 'object') return { ok: false, error: 'not an object' };
	const userId = Number(u.userId);
	const revision = Number(u.revision);
	if (!Number.isSafeInteger(userId) || userId <= 0) return { ok: false, error: 'bad userId' };
	const reset = u.reset === true;
	// a staff reset may come without a name (player offline) - the stored one is kept
	if (!(reset && u.username == null) && (typeof u.username !== 'string' || !USERNAME_RE.test(u.username))) return { ok: false, error: 'bad username' };
	if (!Number.isSafeInteger(revision) || revision <= 0) return { ok: false, error: 'bad revision' };
	for (const k of ['kills', 'wins', 'deaths']) {
		if (!isStat(u[k])) return { ok: false, error: `bad ${k}` };
	}
	if (reset && (u.kills !== 0 || u.wins !== 0 || u.deaths !== 0)) return { ok: false, error: 'a reset must be all zeros' };
	return { ok: true, value: { userId, username: u.username ?? null, kills: u.kills, wins: u.wins, deaths: u.deaths, revision, reset } };
}

async function log(userId, revision, outcome, detail) {
	try {
		await db.query('INSERT INTO sync_log (roblox_user_id, revision, outcome, detail) VALUES ($1, $2, $3, $4)', [userId, revision, outcome, detail || null]);
	} catch (err) {
		console.warn('[sync] log failed', err.message);
	}
}

// Applies an update atomically.
//  source 'game'      - pushed by a Roblox server after the player's data saved.
//                       Must have a NEWER revision, and may never LOWER a stat
//                       (guards against a server that loaded defaults / zeros).
//  source 'opencloud' - read directly from the saved DataStore entry: the
//                       authoritative value, allowed to correct anything.
// Returns 'applied' | 'stale' | 'rejected'.
async function applyUpdate(update, source = 'game') {
	const { userId, kills, wins, deaths, revision, reset } = update;
	let { username } = update;
	const kd = kdRatio(kills, deaths);
	const client = await db.getPool().connect();
	let outcome;
	let detail;
	let row;
	try {
		await client.query('BEGIN');
		// first sight of this player: insert (a concurrent duplicate loses the
		// race harmlessly and falls through to the normal comparison below).
		// A reset for someone we've never seen has nothing to reset.
		if (username) {
			row = (await client.query(
				`INSERT INTO players (roblox_user_id, roblox_username, kills, wins, deaths, kd_ratio, revision, source)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (roblox_user_id) DO NOTHING RETURNING *`,
				[userId, username, kills, wins, deaths, kd, revision, source],
			)).rows[0];
		}
		const cur = row ? null : (await client.query('SELECT * FROM players WHERE roblox_user_id = $1 FOR UPDATE', [userId])).rows[0];
		if (cur && !username) username = cur.roblox_username;
		if (row) {
			outcome = 'applied';
		} else if (!cur) {
			outcome = 'stale';
			detail = 'reset for an unknown player';
		} else if (source === 'game' && revision <= Number(cur.revision)) {
			outcome = 'stale';
			detail = `revision ${revision} <= ${cur.revision}`;
		} else if (source === 'game' && !reset && (kills < Number(cur.kills) || wins < Number(cur.wins) || deaths < Number(cur.deaths))) {
			outcome = 'rejected';
			detail = `decrease ${cur.kills}/${cur.wins}/${cur.deaths} -> ${kills}/${wins}/${deaths}`;
		} else {
			row = (await client.query(
				`UPDATE players SET roblox_username = $2, kills = $3, wins = $4, deaths = $5, kd_ratio = $6,
				   revision = GREATEST(revision, $7), source = $8, last_synced_at = now()
				 WHERE roblox_user_id = $1 RETURNING *`,
				[userId, username, kills, wins, deaths, kd, revision, source],
			)).rows[0];
			outcome = 'applied';
		}
		await client.query('COMMIT');
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		client.release();
	}
	if (outcome !== 'applied' || source !== 'game' || reset) await log(userId, revision, reset ? `${outcome}:reset` : outcome, detail);
	if (outcome === 'applied') events.emit('statsChanged', toPlayer(row));
	return outcome;
}

function toPlayer(r) {
	if (!r) return null;
	return {
		userId: Number(r.roblox_user_id),
		username: r.roblox_username,
		kills: Number(r.kills),
		wins: Number(r.wins),
		deaths: Number(r.deaths),
		kd: Number(r.kd_ratio),
		lastSyncedAt: r.last_synced_at,
	};
}

async function getPlayer(userId) {
	return toPlayer((await db.query('SELECT * FROM players WHERE roblox_user_id = $1', [userId])).rows[0]);
}

async function getPlayerByUsername(username) {
	return toPlayer((await db.query('SELECT * FROM players WHERE lower(roblox_username) = lower($1) ORDER BY last_synced_at DESC LIMIT 1', [username])).rows[0]);
}

// 1-based rank by a stat (ties share the better rank).
async function rankOf(stat, value) {
	if (!['kills', 'wins'].includes(stat)) throw new Error('bad stat');
	const r = await db.query(`SELECT COUNT(*)::int + 1 AS rank FROM players WHERE ${stat} > $1`, [value]);
	return r.rows[0].rank;
}

async function top(stat, limit = 10) {
	if (!['kills', 'wins'].includes(stat)) throw new Error('bad stat');
	const r = await db.query(`SELECT * FROM players WHERE ${stat} > 0 ORDER BY ${stat} DESC, roblox_user_id ASC LIMIT $1`, [limit]);
	return r.rows.map(toPlayer);
}

async function trimLog(days = 14) {
	await db.query(`DELETE FROM sync_log WHERE received_at < now() - ($1 || ' days')::interval`, [String(days)]);
}

module.exports = { validateUpdate, applyUpdate, getPlayer, getPlayerByUsername, rankOf, top, trimLog };
