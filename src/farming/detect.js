// Stat farming / alt farming detectors. Each one looks at the stored,
// server-authoritative history and returns INDICATORS with points; the
// points add up to a severity. Nothing below `severity.low` is reported, so a
// single weak signal (e.g. two friends who often play together) is never
// logged on its own. Detection only - this module never touches the game.
const db = require('../db/pool');
const C = require('./config');

const H = 3600 * 1000;

function severityOf(score) {
	if (score >= C.severity.high) return 'High';
	if (score >= C.severity.medium) return 'Medium';
	if (score >= C.severity.low) return 'Low';
	return null;
}

async function playerInfo(userId) {
	const p = (await db.query('SELECT * FROM players WHERE roblox_user_id = $1', [userId])).rows[0];
	const f = (await db.query('SELECT * FROM farm_players WHERE user_id = $1', [userId])).rows[0];
	const play = (await db.query('SELECT COALESCE(SUM(seconds), 0)::bigint AS s, COUNT(*)::int AS n FROM farm_sessions WHERE user_id = $1', [userId])).rows[0];
	return {
		userId,
		name: f?.name || p?.roblox_username || String(userId),
		kills: p ? Number(p.kills) : null,
		wins: p ? Number(p.wins) : null,
		deaths: p ? Number(p.deaths) : null,
		accountAge: f?.account_age ?? null,
		playSeconds: Number(play.s),
		sessions: play.n,
	};
}

// ---------------------------------------------------------------- 1 + B: one killer, one victim
async function pair(killerId, victimId, now) {
	const kills = (await db.query(
		`SELECT k.at, k.match_id, k.same_team, m.player_count FROM farm_kills k LEFT JOIN farm_matches m ON m.match_id = k.match_id
		 WHERE k.killer_id = $1 AND k.victim_id = $2 AND k.at > $3 AND k.at <= $4 ORDER BY k.at`,
		[killerId, victimId, new Date(now - 7 * 24 * H), new Date(now)],
	)).rows;
	if (!kills.length) return null;
	const inWindow = kills.filter((k) => k.at.getTime() > now - C.repeat.windowMinutes * 60_000);
	const inDay = kills.filter((k) => k.at.getTime() > now - 24 * H);
	const back = Number((await db.query(
		'SELECT COUNT(*)::int AS n FROM farm_kills WHERE killer_id = $2 AND victim_id = $1 AND at > $3',
		[killerId, victimId, new Date(now - 7 * 24 * H)],
	)).rows[0].n);
	const shared = Number((await db.query(
		`SELECT COUNT(*)::int AS n FROM farm_match_players a JOIN farm_match_players b ON a.match_id = b.match_id
		 JOIN farm_matches m ON m.match_id = a.match_id
		 WHERE a.user_id = $1 AND b.user_id = $2 AND m.started_at > $3`,
		[killerId, victimId, new Date(now - 7 * 24 * H)],
	)).rows[0].n);
	const victim = await playerInfo(victimId);
	const ind = [];
	// the main signal: how often the same opponent goes down
	let base = null;
	if (inWindow.length >= C.repeat.high) base = { points: 5, reason: `Same opponent eliminated ${inWindow.length} times within ${C.repeat.windowMinutes} minutes` };
	else if (inWindow.length >= C.repeat.medium) base = { points: 4, reason: `Same opponent eliminated ${inWindow.length} times within ${C.repeat.windowMinutes} minutes` };
	else if (inWindow.length >= C.repeat.low) base = { points: 3, reason: `Same opponent eliminated ${inWindow.length} times within ${C.repeat.windowMinutes} minutes` };
	else if (inDay.length >= C.repeat.dayLow) base = { points: 3, reason: `Same opponent eliminated ${inDay.length} times within 24 hours` };
	const oneSided = shared >= C.oneSided.minSharedMatches && kills.length >= C.oneSided.minKills && back <= kills.length * C.oneSided.maxReturnRatio;
	if (!base && !oneSided) return null; // repeated encounters alone are normal - nothing to report
	if (base) ind.push(base);
	if (oneSided) ind.push({ points: base ? 1 : 3, reason: `One-sided: met in ${shared} matches, ${kills.length} kills on them vs ${back} back (7 days)` });
	const matches = new Set(kills.map((k) => k.match_id).filter(Boolean));
	if (matches.size >= 3) ind.push({ points: 1, reason: `Repeated across ${matches.size} different matches` });
	if (victim.accountAge != null && victim.accountAge < C.youngAccountDays) ind.push({ points: 2, reason: `Victim's account is only ${victim.accountAge} day(s) old` });
	if (victim.kills != null && victim.kills < 20) ind.push({ points: 1, reason: `Victim has only ${victim.kills} kill(s) of their own` });
	const sizes = kills.map((k) => k.player_count).filter((s) => s != null);
	const avg = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null;
	if (avg != null && avg <= C.pairing.smallMatchPlayers) ind.push({ points: 1, reason: `Mostly tiny matches (avg ${avg.toFixed(1)} players)` });
	const teamKills = kills.filter((k) => k.same_team).length;
	if (teamKills >= 3) ind.push({ points: 2, reason: `${teamKills} of them were on their OWN team` });
	const shown = inWindow.length >= C.repeat.low ? inWindow : inDay.length >= C.repeat.dayLow ? inDay : kills;
	return {
		key: `pair:${killerId}:${victimId}`, kind: 'Repeated eliminations of one player', userId: killerId, indicators: ind,
		data: {
			victim, total: shown.length, total7d: kills.length, back, shared,
			matches: new Set(shown.map((k) => k.match_id).filter(Boolean)).size,
			first: shown[0].at, last: shown[shown.length - 1].at,
			times: shown.map((k) => k.at),
		},
	};
}

// ---------------------------------------------------------------- C + E: several accounts feeding one player
async function feeders(killerId, now) {
	const since = new Date(now - 24 * H);
	const rows = (await db.query(
		`SELECT victim_id, COUNT(*)::int AS n, MIN(at) AS first, MAX(at) AS last FROM farm_kills
		 WHERE killer_id = $1 AND at > $2 AND at <= $3 GROUP BY victim_id HAVING COUNT(*) >= $4 ORDER BY n DESC`,
		[killerId, since, new Date(now), C.feeders.killsEach],
	)).rows;
	if (rows.length < C.feeders.minVictims) return null;
	const victims = [];
	for (const r of rows.slice(0, 10)) victims.push({ ...(await playerInfo(Number(r.victim_id))), n: r.n });
	const ind = [{ points: 4, reason: `${rows.length} different accounts were each eliminated ${C.feeders.killsEach}+ times by them in 24 hours` }];
	const young = victims.filter((v) => v.accountAge != null && v.accountAge < C.youngAccountDays).length;
	if (young >= 2) ind.push({ points: 2, reason: `${young} of those accounts are under ${C.youngAccountDays} days old` });
	const weak = victims.filter((v) => v.kills != null && v.kills < 20).length;
	if (weak >= 2) ind.push({ points: 1, reason: `${weak} of those accounts barely have any kills of their own` });
	// E) do the victims keep showing up together? (a coordinated group)
	const ids = victims.map((v) => v.userId);
	const together = Number((await db.query(
		`SELECT COUNT(DISTINCT a.match_id)::int AS n FROM farm_match_players a
		 JOIN farm_matches m ON m.match_id = a.match_id
		 WHERE a.user_id = $1 AND m.started_at > $2 AND (
		   SELECT COUNT(*) FROM farm_match_players b WHERE b.match_id = a.match_id AND b.user_id = ANY($3::bigint[])) >= 2`,
		[killerId, since, ids],
	)).rows[0].n);
	if (together >= 5) ind.push({ points: 1, reason: `These accounts were in ${together} matches TOGETHER with them (a recurring group)` });
	return { key: `feeders:${killerId}`, kind: 'Multiple accounts feeding one player', userId: killerId, indicators: ind, data: { victims, together } };
}

// ---------------------------------------------------------------- A: the same two accounts in the same small matches
async function pairing(userId, now) {
	const since = new Date(now - 24 * H);
	const rows = (await db.query(
		`SELECT b.user_id AS other, COUNT(*)::int AS n, AVG(m.player_count)::float AS avg FROM farm_match_players a
		 JOIN farm_match_players b ON b.match_id = a.match_id AND b.user_id <> a.user_id
		 JOIN farm_matches m ON m.match_id = a.match_id
		 WHERE a.user_id = $1 AND m.started_at > $2 AND m.player_count <= $3
		 GROUP BY b.user_id HAVING COUNT(*) >= $4 ORDER BY n DESC LIMIT 3`,
		[userId, since, C.pairing.smallMatchPlayers, C.pairing.minSharedMatches],
	)).rows;
	const out = [];
	for (const r of rows) {
		const other = Number(r.other);
		const k = (await db.query(
			`SELECT COUNT(*) FILTER (WHERE killer_id = $1)::int AS ab, COUNT(*) FILTER (WHERE killer_id = $2)::int AS ba
			 FROM farm_kills WHERE at > $3 AND ((killer_id = $1 AND victim_id = $2) OR (killer_id = $2 AND victim_id = $1))`,
			[userId, other, since],
		)).rows[0];
		const wins = Number((await db.query(
			`SELECT COUNT(*)::int AS n FROM farm_wins w JOIN farm_match_players p ON p.match_id = w.match_id AND p.user_id = $2
			 JOIN farm_matches m ON m.match_id = w.match_id WHERE w.user_id = $1 AND w.at > $3 AND m.player_count <= $4`,
			[userId, other, since, C.pairing.smallMatchPlayers],
		)).rows[0].n);
		const partner = await playerInfo(other);
		const ind = [{ points: 2, reason: `Played ${r.n} small matches (avg ${Number(r.avg).toFixed(1)} players) with the same account in 24 hours` }];
		if (k.ab >= 5 && k.ba <= k.ab * 0.2) ind.push({ points: 2, reason: `Kills between them: ${k.ab} vs ${k.ba} - one-sided` });
		if (wins >= 5) ind.push({ points: 2, reason: `Won ${wins} of those small matches` });
		if (partner.accountAge != null && partner.accountAge < C.youngAccountDays) ind.push({ points: 1, reason: `The other account is only ${partner.accountAge} day(s) old` });
		out.push({ key: `pairing:${userId}:${other}`, kind: 'Repeated player pairing', userId, indicators: ind, data: { partner, shared: r.n, avg: Number(r.avg), ab: k.ab, ba: k.ba, wins } });
	}
	return out;
}

// ---------------------------------------------------------------- 2 + D: stat ratios and jumps
async function ratios(userId, now) {
	const me = await playerInfo(userId);
	const ind = [];
	const data = { recent: [] };
	if (me.wins != null && me.wins >= C.ratio.minWins && me.kills <= me.wins * C.ratio.maxKillsPerWin) {
		ind.push({ points: 3, reason: `${me.kills} kills for ${me.wins} wins (${(me.kills / Math.max(1, me.wins)).toFixed(2)} kills per win)` });
	}
	const snaps = (await db.query(
		'SELECT kills, wins, at FROM farm_stat_snapshots WHERE user_id = $1 AND at > $2 AND at <= $3 ORDER BY at',
		[userId, new Date(now - C.ratio.jumpHours * H), new Date(now)],
	)).rows;
	if (snaps.length >= 2) {
		const a = snaps[0];
		const b = snaps[snaps.length - 1];
		const dk = Number(b.kills) - Number(a.kills);
		const dw = Number(b.wins) - Number(a.wins);
		data.recent = snaps.slice(-8).map((s) => ({ kills: Number(s.kills), wins: Number(s.wins), at: s.at }));
		if (dk >= C.ratio.jumpKills) ind.push({ points: 3, reason: `+${dk} kills in ${C.ratio.jumpHours} hour(s)` });
		if (dw >= C.ratio.jumpWins) ind.push({ points: 3, reason: `+${dw} wins in ${C.ratio.jumpHours} hour(s)` });
	}
	const hours = me.playSeconds / 3600;
	const tracked = (await db.query(
		`SELECT COUNT(*)::int AS kills FROM farm_kills WHERE killer_id = $1`, [userId],
	)).rows[0].kills;
	if (hours >= C.ratio.minPlayHours && tracked / hours >= C.ratio.killsPerHour) {
		ind.push({ points: 2, reason: `${tracked} kills in ${hours.toFixed(1)} tracked hours of play (${(tracked / hours).toFixed(0)}/hour)` });
	}
	const m = (await db.query(
		`SELECT COUNT(*)::int AS played, COUNT(w.user_id)::int AS won, AVG(fm.player_count)::float AS avg
		 FROM farm_match_players p JOIN farm_matches fm ON fm.match_id = p.match_id
		 LEFT JOIN farm_wins w ON w.match_id = p.match_id AND w.user_id = p.user_id WHERE p.user_id = $1`,
		[userId],
	)).rows[0];
	data.matches = m;
	if (m.played >= C.ratio.minMatches && m.won / m.played >= C.ratio.winRate) {
		ind.push({ points: 2, reason: `Won ${m.won} of ${m.played} tracked matches (${Math.round((100 * m.won) / m.played)}%)` });
		if (m.avg != null && m.avg <= C.pairing.smallMatchPlayers) ind.push({ points: 1, reason: `Those matches averaged only ${m.avg.toFixed(1)} players` });
	}
	if (!ind.length) return null;
	return { key: `ratio:${userId}`, kind: 'Suspicious stat pattern', userId, indicators: ind, data };
}

// everything worth reporting for one player right now
async function scanPlayer(userId, now = Date.now()) {
	const found = [];
	const victims = (await db.query(
		'SELECT DISTINCT victim_id FROM farm_kills WHERE killer_id = $1 AND at > $2',
		[userId, new Date(now - 7 * 24 * H)],
	)).rows.map((r) => Number(r.victim_id));
	for (const v of victims) {
		const p = await pair(userId, v, now);
		if (p) found.push(p);
	}
	const f = await feeders(userId, now);
	if (f) found.push(f);
	found.push(...(await pairing(userId, now)));
	const r = await ratios(userId, now);
	if (r) found.push(r);
	const out = [];
	for (const inc of found) {
		inc.score = inc.indicators.reduce((s, i) => s + i.points, 0);
		inc.severity = severityOf(inc.score);
		if (inc.severity) out.push(inc);
	}
	return out;
}

module.exports = { scanPlayer, severityOf, playerInfo };
