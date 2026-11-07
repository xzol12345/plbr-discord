// Stat farming / alt farming detection against a real (test) Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');

const KEY = 'test-key-'.padEnd(48, 'x');
process.env.ROBLOX_SYNC_KEYS = KEY;
if (!process.env.TEST_DATABASE_URL) { console.error('Set TEST_DATABASE_URL'); process.exit(1); }
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const db = require('../src/db/pool');
const { createApp } = require('../src/api/server');
const detect = require('../src/farming/detect');
const report = require('../src/farming/report');

let server;
let base;
const NOW = Date.now();
const sec = (msAgo) => (NOW - msAgo) / 1000;
const MIN = 60_000;

test.before(async () => {
	await db.migrate();
	await db.query('TRUNCATE farm_matches, farm_match_players, farm_kills, farm_wins, farm_sessions, farm_players, farm_stat_snapshots, farm_incidents, players');
	server = createApp().listen(0);
	base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server?.close(); await db.close(); });

const post = (events) => fetch(`${base}/v1/roblox/farm`, {
	method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify({ events }),
}).then((r) => r.json());

let seq = 0;
// one match with these players; optional kills [killer, victim] and winner
async function match({ players, kills = [], winner, minutesAgo, mode = 'Solos' }) {
	seq += 1;
	const matchId = `match-${seq}`;
	const at = sec(minutesAgo * MIN);
	const ev = [{ type: 'match', matchId, serverId: 'server-1', mode, at, players: players.map(([userId, name, accountAge = 400]) => ({ userId, name, accountAge, teamId: 0 })) }];
	kills.forEach(([k, v], i) => ev.push({ type: 'kill', id: `k-${seq}-${i}`, matchId, killerId: k, victimId: v, at: at + 60 + i }));
	if (winner) ev.push({ type: 'win', matchId, userId: winner, at: at + 120 });
	return post(ev);
}
const setStats = (userId, name, kills, wins, deaths) => db.query(
	`INSERT INTO players (roblox_user_id, roblox_username, kills, wins, deaths, revision) VALUES ($1, $2, $3, $4, $5, 1)
	 ON CONFLICT (roblox_user_id) DO UPDATE SET kills = $3, wins = $4, deaths = $5`, [userId, name, kills, wins, deaths]);

test('API: validates events, ignores re-sent ones, never trusts junk', async () => {
	let r = await post([{ type: 'kill', id: 'dup-1', killerId: 5, victimId: 6, at: sec(0) }, { type: 'kill', id: 'dup-1', killerId: 5, victimId: 6, at: sec(0) }]);
	assert.deepEqual(r, { accepted: 2, rejected: 0 });
	assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM farm_kills WHERE event_id = 'dup-1'")).rows[0].n, 1);
	r = await post([{ type: 'kill', id: 'x1', killerId: 5, victimId: 5, at: sec(0) }, { type: 'kill', id: 'x2', killerId: -1, victimId: 6, at: sec(0) },
		{ type: 'kill', id: 'x3', killerId: 5, victimId: 6, at: sec(30 * 24 * 60 * MIN) }, { type: 'nope' }, { type: 'win', matchId: 'bad id!', userId: 5, at: sec(0) }]);
	assert.deepEqual(r, { accepted: 0, rejected: 5 });
	const bad = await fetch(`${base}/v1/roblox/farm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{"events":[]}' });
	assert.equal(bad.status, 401);
	await db.query('TRUNCATE farm_kills');
});

test('1+2: same opponent 15 times in 30 minutes across 15 matches -> one detection with all 15 timestamps', async () => {
	await setStats(100, 'FarmerA', 450, 12, 80);
	await setStats(200, 'AltB', 3, 0, 300);
	for (let i = 0; i < 15; i += 1) await match({ players: [[100, 'FarmerA'], [200, 'AltB', 4]], kills: [[100, 200]], winner: 100, minutesAgo: 30 - i * 2 });
	const found = await detect.scanPlayer(100, NOW + 5 * MIN);
	const pairInc = found.find((f) => f.key === 'pair:100:200');
	assert.ok(pairInc, 'pair detection');
	assert.equal(pairInc.data.total, 15);
	assert.equal(pairInc.data.times.length, 15);
	assert.equal(pairInc.data.matches, 15);
	assert.ok(['Medium', 'High'].includes(pairInc.severity), pairInc.severity);
	const reasons = pairInc.indicators.map((i) => i.reason).join(' | ');
	assert.match(reasons, /15 times within 60 minutes/);
	assert.match(reasons, /15 different matches/);
	assert.match(reasons, /only 4 day/);
	// the embed carries everything staff need
	const json = report.buildEmbed(pairInc, await detect.playerInfo(100)).toJSON();
	const text = JSON.stringify(json);
	for (const s of ['POSSIBLE STAT FARMING DETECTED', 'FarmerA', 'AltB', 'Total Eliminations: **15**', 'Elimination Timestamps', 'Needs Staff Review', 'NOT proof']) assert.ok(text.includes(s), s);
	assert.equal((text.match(/<t:\d+:f>/g) || []).length >= 15, true);
	for (const f of json.fields) assert.ok(f.value.length <= 1024, f.name);
});

test('3: several accounts feeding one player -> feeders detection (+ recurring group)', async () => {
	await setStats(300, 'Booster', 900, 40, 50);
	for (const [id, name] of [[301, 'altone'], [302, 'alttwo'], [303, 'altthree']]) await setStats(id, name, 1, 0, 50);
	for (let i = 0; i < 6; i += 1) {
		await match({ players: [[300, 'Booster'], [301, 'altone', 2], [302, 'alttwo', 3], [303, 'altthree', 1]], kills: [[300, 301], [300, 302], [300, 303]], winner: 300, minutesAgo: 200 - i * 20 });
	}
	const found = await detect.scanPlayer(300, NOW);
	const f = found.find((x) => x.key === 'feeders:300');
	assert.ok(f);
	assert.equal(f.data.victims.length, 3);
	assert.ok(f.severity === 'High' || f.severity === 'Medium');
	assert.match(f.indicators.map((i) => i.reason).join('|'), /3 different accounts/);
	assert.match(f.indicators.map((i) => i.reason).join('|'), /TOGETHER/);
});

test('4: 4 kills and 60 wins is flagged as a stat pattern (Low on its own)', async () => {
	await setStats(400, 'WinsOnly', 4, 60, 10);
	const r = (await detect.scanPlayer(400, NOW)).find((x) => x.key === 'ratio:400');
	assert.ok(r);
	assert.equal(r.severity, 'Low');
	assert.match(r.indicators[0].reason, /4 kills for 60 wins/);
});

test('5: a normal strong player (many different opponents, a regular friend) is NOT flagged', async () => {
	await setStats(500, 'GoodPlayer', 2000, 150, 900);
	for (let i = 0; i < 30; i += 1) {
		const victim = 6000 + i;
		await match({ players: [[500, 'GoodPlayer'], [victim, `rando${i}`], [7000, 'BestFriend'], [8000 + i, `other${i}`], [9000 + i, `more${i}`], [9500 + i, `last${i}`]], kills: [[500, victim], ...(i % 10 === 0 ? [[500, 7000]] : [])], winner: i % 3 === 0 ? 500 : undefined, minutesAgo: 600 - i * 15 });
	}
	assert.deepEqual(await detect.scanPlayer(500, NOW), []);
	// meeting the same friend often but rarely killing them is not suspicious either
	assert.deepEqual((await detect.scanPlayer(7000, NOW)).map((x) => x.key), []);
});

test('6+7: one message per incident (edited, not re-posted) and retried after Discord downtime', async () => {
	const sent = [];
	const edits = [];
	let down = true;
	const channel = {
		id: 'chan',
		send: async (p) => { if (down) throw new Error('Discord down'); sent.push(p); return { id: `msg${sent.length}` }; },
		messages: { fetch: async (id) => ({ id, edit: async (p) => { edits.push([id, p]); } }) },
	};
	const scanPublish = async (now) => {
		const out = [];
		for (const inc of await detect.scanPlayer(100, now)) out.push(await report.publish(channel, inc, now).catch((e) => `error:${e.message}`));
		return out;
	};
	// Discord down: nothing sent, nothing lost
	assert.match((await scanPublish(NOW + 6 * MIN)).join(','), /error:Discord down/);
	down = false;
	assert.ok((await scanPublish(NOW + 7 * MIN)).includes('new')); // retried
	const posts = sent.length;
	// same evidence again -> no new message, no edit
	assert.ok((await scanPublish(NOW + 8 * MIN)).every((a) => a === 'none'));
	assert.equal(sent.length, posts);
	// more kills -> the SAME message is edited
	for (let i = 0; i < 3; i += 1) await match({ players: [[100, 'FarmerA'], [200, 'AltB', 4]], kills: [[100, 200]], minutesAgo: 1 - i * 0.3 });
	const actions = await scanPublish(NOW + 15 * MIN);
	assert.ok(actions.includes('edit'), actions.join(','));
	assert.equal(sent.length, posts);
	assert.ok(edits.length >= 1);
	const row = (await db.query("SELECT * FROM farm_incidents WHERE key = 'pair:100:200'")).rows[0];
	assert.equal(row.message_id, 'msg1');
});

test('8: detection code never touches the game - it only stores and reports', async () => {
	const fs = require('node:fs');
	for (const f of ['detect.js', 'report.js', 'scanner.js', 'ingest.js']) {
		const src = fs.readFileSync(`${__dirname}/../src/farming/${f}`, 'utf8');
		assert.ok(!/queue\.enqueue|game_commands|kick|ban\(/i.test(src.replace(/\/\/.*$/gm, '')), f);
	}
});
