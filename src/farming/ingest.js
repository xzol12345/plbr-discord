// Stores farming-detection events sent by game servers (POST /v1/roblox/farm).
// Everything comes from the GAME SERVER (server-authoritative kill credit /
// match rosters / wins) - clients never reach this. Every event is validated;
// re-sent events are ignored (kill / session ids, match ids are unique).
const db = require('../db/pool');

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v);
const name = (v) => (typeof v === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(v) ? v : null);

function when(unixSeconds, now = Date.now()) {
	if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) return null;
	const ms = Math.round(unixSeconds * 1000);
	if (ms < now - MAX_AGE_MS || ms > now + 5 * 60_000) return null;
	return new Date(ms);
}

function validate(e, now = Date.now()) {
	if (!e || typeof e !== 'object') return null;
	const at = when(e.at, now);
	switch (e.type) {
		case 'match': {
			if (!isKey(e.matchId) || !at || !Array.isArray(e.players) || e.players.length > 100) return null;
			const players = e.players.filter((p) => p && isId(p.userId)).map((p) => ({
				userId: p.userId, name: name(p.name), teamId: Number.isSafeInteger(p.teamId) ? p.teamId : 0,
				accountAge: Number.isSafeInteger(p.accountAge) && p.accountAge >= 0 ? p.accountAge : null,
			}));
			return { type: 'match', matchId: e.matchId, serverId: typeof e.serverId === 'string' ? e.serverId.slice(0, 64) : null, mode: typeof e.mode === 'string' ? e.mode.slice(0, 16) : null, at, players };
		}
		case 'kill':
			if (!isKey(e.id) || !isId(e.killerId) || !isId(e.victimId) || e.killerId === e.victimId || !at) return null;
			return { type: 'kill', id: e.id, matchId: isKey(e.matchId) ? e.matchId : null, killerId: e.killerId, victimId: e.victimId, sameTeam: e.sameTeam === true, at };
		case 'win':
			if (!isKey(e.matchId) || !isId(e.userId) || !at) return null;
			return { type: 'win', matchId: e.matchId, userId: e.userId, at };
		case 'session': {
			const joined = when(e.joinedAt, now);
			if (!isKey(e.id) || !isId(e.userId) || !joined || !Number.isSafeInteger(e.seconds) || e.seconds < 0 || e.seconds > 7 * 24 * 3600) return null;
			return { type: 'session', id: e.id, userId: e.userId, name: name(e.name), accountAge: Number.isSafeInteger(e.accountAge) ? e.accountAge : null, joinedAt: joined, seconds: e.seconds };
		}
		default:
			return null;
	}
}

async function rememberPlayer(userId, playerName, accountAge) {
	if (!playerName) return;
	await db.query(
		`INSERT INTO farm_players (user_id, name, account_age, updated_at) VALUES ($1, $2, $3, now())
		 ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, account_age = COALESCE(EXCLUDED.account_age, farm_players.account_age), updated_at = now()`,
		[userId, playerName, accountAge],
	);
}

// returns the user ids of killers in this batch (to scan them soon)
async function store(events) {
	const killers = new Set();
	for (const e of events) {
		if (e.type === 'match') {
			await db.query(
				`INSERT INTO farm_matches (match_id, server_id, mode, player_count, started_at) VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (match_id) DO NOTHING`,
				[e.matchId, e.serverId, e.mode, e.players.length, e.at],
			);
			for (const p of e.players) {
				await db.query('INSERT INTO farm_match_players (match_id, user_id, team_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [e.matchId, p.userId, p.teamId]);
				await rememberPlayer(p.userId, p.name, p.accountAge);
			}
		} else if (e.type === 'kill') {
			const r = await db.query(
				`INSERT INTO farm_kills (event_id, match_id, killer_id, victim_id, same_team, at) VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (event_id) DO NOTHING`,
				[e.id, e.matchId, e.killerId, e.victimId, e.sameTeam, e.at],
			);
			if (r.rowCount) killers.add(e.killerId);
		} else if (e.type === 'win') {
			await db.query('INSERT INTO farm_wins (match_id, user_id, at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [e.matchId, e.userId, e.at]);
			killers.add(e.userId);
		} else if (e.type === 'session') {
			await db.query('INSERT INTO farm_sessions (event_id, user_id, joined_at, seconds) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [e.id, e.userId, e.joinedAt, e.seconds]);
			await rememberPlayer(e.userId, e.name, e.accountAge);
		}
	}
	return [...killers];
}

async function snapshot(player) {
	// at most one snapshot per player every 5 minutes
	await db.query(
		`INSERT INTO farm_stat_snapshots (user_id, kills, wins, deaths)
		 SELECT $1, $2, $3, $4 WHERE NOT EXISTS (
		   SELECT 1 FROM farm_stat_snapshots WHERE user_id = $1 AND at > now() - interval '5 minutes')`,
		[player.userId, player.kills, player.wins, player.deaths],
	);
}

async function trim(days) {
	const d = String(days);
	for (const [table, col] of [['farm_kills', 'at'], ['farm_wins', 'at'], ['farm_sessions', 'joined_at'], ['farm_stat_snapshots', 'at'], ['farm_incidents', 'last_at']]) {
		await db.query(`DELETE FROM ${table} WHERE ${col} < now() - ($1 || ' days')::interval`, [d]);
	}
	await db.query(`DELETE FROM farm_match_players WHERE match_id IN (SELECT match_id FROM farm_matches WHERE started_at < now() - ($1 || ' days')::interval)`, [d]);
	await db.query(`DELETE FROM farm_matches WHERE started_at < now() - ($1 || ' days')::interval`, [d]);
}

module.exports = { validate, store, snapshot, trim };
