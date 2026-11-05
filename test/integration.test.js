// Integration tests against a real, EMPTY Postgres database.
// Run: TEST_DATABASE_URL=postgres://user:pass@localhost:5432/plbr_test npm test
// (never point this at the production database - tables are wiped first)
const test = require('node:test');
const assert = require('node:assert/strict');

const KEY = 'test-key-'.padEnd(48, 'x');
process.env.ROBLOX_SYNC_KEYS = KEY;
if (!process.env.TEST_DATABASE_URL) {
	console.error('Set TEST_DATABASE_URL to an empty test database');
	process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const db = require('../src/db/pool');
const store = require('../src/stats/store');
const { kdRatio, formatKd } = require('../src/stats/kd');
const { KILL_TIERS, WIN_TIERS, parseTiers, tierFor } = require('../src/stats/tiers');
const { createApp } = require('../src/api/server');
const events = require('../src/events');

let server;
let base;

test.before(async () => {
	await db.query('DROP TABLE IF EXISTS players, links, sync_log, bot_state, schema_migrations CASCADE');
	await db.migrate();
	server = createApp().listen(0);
	base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
	server?.close();
	await db.close();
});

const post = (body, key = KEY) => fetch(`${base}/v1/roblox/stats`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
	body: JSON.stringify(body),
});

test('K/D handles zero deaths and rounds', () => {
	assert.equal(kdRatio(10, 0), 10);
	assert.equal(kdRatio(0, 0), 0);
	assert.equal(kdRatio(7, 3), 2.33);
	assert.equal(formatKd(5, 2), '2.50');
	assert.ok(Number.isFinite(kdRatio(5, 0)));
});

test('tiers: exactly one per progression, independent', () => {
	assert.equal(tierFor(KILL_TIERS, 0).name, 'Recruit');
	assert.equal(tierFor(KILL_TIERS, 99).name, 'Recruit');
	assert.equal(tierFor(KILL_TIERS, 100).name, 'Fighter');
	assert.equal(tierFor(KILL_TIERS, 1000).name, 'Assassin');
	assert.equal(tierFor(KILL_TIERS, 10000).name, 'Untouchable');
	assert.equal(tierFor(WIN_TIERS, 9), null);
	assert.equal(tierFor(WIN_TIERS, 10).name, 'Survivor');
	assert.equal(tierFor(WIN_TIERS, 100).name, 'Elite Champion');
	assert.equal(tierFor(WIN_TIERS, 500).name, 'PL:BR Legend');
});

test('custom role lists from env vars', () => {
	assert.equal(parseTiers(undefined, 'X'), null);
	assert.deepEqual(parseTiers('none', 'X'), []);
	const t = parseTiers(' 500 = Killer Pro ;0=Newbie;100=Fighter', 'X');
	assert.deepEqual(t.map((x) => [x.min, x.name]), [[0, 'Newbie'], [100, 'Fighter'], [500, 'Killer Pro']]);
	assert.equal(tierFor(t, 499).name, 'Fighter');
	assert.throws(() => parseTiers('abc', 'X'));
	assert.throws(() => parseTiers('0=A;0=B', 'X'));
});

test('API rejects missing / wrong keys', async () => {
	assert.equal((await post({ players: [] }, 'nope')).status, 401);
	const r = await fetch(`${base}/v1/roblox/stats`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
	assert.equal(r.status, 401);
});

test('API validates payloads', async () => {
	const r = await post({ players: [{ userId: -1, username: 'x', kills: 1, wins: 1, deaths: 1, revision: 1 }] });
	assert.equal(r.status, 200);
	assert.equal((await r.json()).results[0].outcome, 'invalid');
	assert.equal((await post({ players: 'no' })).status, 400);
	const bad = await post({ players: [{ userId: 5, username: 'ok_name', kills: 1.5, wins: 0, deaths: 0, revision: 1 }] });
	assert.equal((await bad.json()).results[0].outcome, 'invalid');
});

test('sync: apply, duplicate, out-of-order, never inflate', async () => {
	const changed = [];
	events.on('statsChanged', (p) => changed.push(p));
	const u = { userId: 88685, username: 'Player497', kills: 10, wins: 2, deaths: 5, revision: 100 };
	let r = await (await post({ players: [u] })).json();
	assert.equal(r.results[0].outcome, 'applied');
	// exact duplicate (retry) -> stale, nothing added
	r = await (await post({ players: [u] })).json();
	assert.equal(r.results[0].outcome, 'stale');
	// newer
	r = await (await post({ players: [{ ...u, kills: 12, deaths: 6, revision: 105 }] })).json();
	assert.equal(r.results[0].outcome, 'applied');
	// an OLDER request arriving late is ignored
	r = await (await post({ players: [{ ...u, kills: 11, revision: 103 }] })).json();
	assert.equal(r.results[0].outcome, 'stale');
	const p = await store.getPlayer(88685);
	assert.deepEqual([p.kills, p.wins, p.deaths, p.kd], [12, 2, 6, 2]);
	assert.equal(changed.length, 2);
});

test('sync: a zero / lower load from the game is rejected', async () => {
	const r = await (await post({ players: [{ userId: 88685, username: 'Player497', kills: 0, wins: 0, deaths: 0, revision: 200 }] })).json();
	assert.equal(r.results[0].outcome, 'rejected');
	const p = await store.getPlayer(88685);
	assert.equal(p.kills, 12);
	const log = await db.query("SELECT outcome FROM sync_log WHERE roblox_user_id = 88685 AND outcome = 'rejected'");
	assert.equal(log.rowCount, 1);
});

test('sync: Open Cloud (saved data) is authoritative and may correct', async () => {
	assert.equal(await store.applyUpdate({ userId: 88685, username: 'Player497', kills: 11, wins: 2, deaths: 6, revision: 1 }, 'opencloud'), 'applied');
	const p = await store.getPlayer(88685);
	assert.equal(p.kills, 11);
	// revision is kept, so older game pushes stay ignored
	const r = await (await post({ players: [{ userId: 88685, username: 'Player497', kills: 50, wins: 2, deaths: 6, revision: 104 }] })).json();
	assert.equal(r.results[0].outcome, 'stale');
});

test('usernames update, UserId stays the key', async () => {
	await post({ players: [{ userId: 88685, username: 'Renamed_497', kills: 13, wins: 2, deaths: 6, revision: 300 }] });
	assert.equal((await store.getPlayer(88685)).username, 'Renamed_497');
	assert.equal((await store.getPlayerByUsername('renamed_497')).userId, 88685);
});

test('leaderboards and ranks', async () => {
	const batch = [];
	for (let i = 1; i <= 15; i++) batch.push({ userId: 1000 + i, username: `p${i}xx`, kills: i * 100, wins: 16 - i, deaths: i, revision: 1 });
	const r = await (await post({ players: batch })).json();
	assert.ok(r.results.every((x) => x.outcome === 'applied'));
	const topK = await store.top('kills', 10);
	assert.equal(topK.length, 10);
	assert.equal(topK[0].userId, 1015);
	assert.ok(topK.every((p, i) => i === 0 || topK[i - 1].kills >= p.kills));
	const topW = await store.top('wins', 10);
	assert.equal(topW[0].userId, 1001);
	assert.equal(await store.rankOf('kills', 1500), 1);
	assert.equal(await store.rankOf('kills', 1400), 2);
});

test('concurrent duplicates cannot double-apply', async () => {
	const u = { userId: 777, username: 'racer_1', kills: 5, wins: 0, deaths: 1, revision: 50 };
	const results = await Promise.all(Array.from({ length: 8 }, () => post({ players: [u] }).then((r) => r.json())));
	const outcomes = results.map((r) => r.results[0].outcome);
	assert.equal(outcomes.filter((o) => o === 'applied').length, 1);
	assert.ok(outcomes.every((o) => o === 'applied' || o === 'stale'), outcomes.join());
	assert.equal((await store.getPlayer(777)).kills, 5);
});

test('staff reset: only all-zero resets may lower stats; names kept', async () => {
	let r = await (await post({ players: [{ userId: 777, kills: 1, wins: 0, deaths: 0, revision: 60, reset: true }] })).json();
	assert.equal(r.results[0].outcome, 'invalid');
	r = await (await post({ players: [{ userId: 777, kills: 0, wins: 0, deaths: 0, revision: 61, reset: true }] })).json();
	assert.equal(r.results[0].outcome, 'applied');
	const p = await store.getPlayer(777);
	assert.deepEqual([p.username, p.kills, p.deaths], ['racer_1', 0, 0]);
	r = await (await post({ players: [{ userId: 424242, kills: 0, wins: 0, deaths: 0, revision: 1, reset: true }] })).json();
	assert.equal(r.results[0].outcome, 'stale'); // never seen: nothing to reset
	assert.equal(await store.getPlayer(424242), null);
});
