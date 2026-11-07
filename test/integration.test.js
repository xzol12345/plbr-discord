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
	await db.query('DROP TABLE IF EXISTS players, links, sync_log, bot_state, game_commands, boost_rewards, schema_migrations CASCADE');
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

const queue = require('../src/commands/queue');
const postJson = (path, body, key = KEY) => fetch(`${base}${path}`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
	body: JSON.stringify(body),
});

test('commands: one server claims, only it can finish, finish is final', async () => {
	const cmd = await queue.enqueue('ban', { username: 'cheater_1', reason: 'aimbot', type: 'normal', by: 'x (Discord)', discordId: '1' }, '1');
	assert.equal((await postJson('/v1/roblox/commands/claim', {}, KEY)).status, 400);
	assert.equal((await postJson('/v1/roblox/commands/claim', { serverId: 'A' }, 'nope'.padEnd(40, 'x'))).status, 401);
	const [a, b] = await Promise.all([
		postJson('/v1/roblox/commands/claim', { serverId: 'A' }).then((r) => r.json()),
		postJson('/v1/roblox/commands/claim', { serverId: 'B' }).then((r) => r.json()),
	]);
	const claimedBy = [a, b].filter((r) => r.commands.some((c) => c.id === cmd.id));
	assert.equal(claimedBy.length, 1);
	const winner = claimedBy[0] === a ? 'A' : 'B';
	const loser = winner === 'A' ? 'B' : 'A';
	const waiting = queue.waitFor(cmd.id, 3000);
	assert.equal((await (await postJson(`/v1/roblox/commands/${cmd.id}/result`, { serverId: loser, ok: true, message: 'x' })).json()).ok, false);
	assert.equal((await (await postJson(`/v1/roblox/commands/${cmd.id}/result`, { serverId: winner, ok: true, message: 'Banned cheater_1' })).json()).ok, true);
	const done = await waiting;
	assert.equal(done.status, 'done');
	assert.equal(done.result.message, 'Banned cheater_1');
	// already finished: a second answer changes nothing, and it's never handed out again
	assert.equal((await (await postJson(`/v1/roblox/commands/${cmd.id}/result`, { serverId: winner, ok: false, message: 'late' })).json()).ok, false);
	assert.equal((await queue.get(cmd.id)).result.message, 'Banned cheater_1');
	const again = await (await postJson('/v1/roblox/commands/claim', { serverId: 'C' })).json();
	assert.ok(!again.commands.some((c) => c.id === cmd.id));
});

test('commands: an unanswered claim is handed out again, then given up', async () => {
	const cmd = await queue.enqueue('ban', { username: 'cheater_2', reason: 'fly', type: 'ingame', by: 'x', discordId: '1' }, '1');
	await queue.claim('A');
	assert.equal((await queue.claim('B')).length, 0); // still within the timeout
	await db.query("UPDATE game_commands SET claimed_at = now() - interval '10 minutes' WHERE id = $1", [cmd.id]);
	assert.deepEqual((await queue.claim('B')).map((c) => c.id), [cmd.id]);
	await db.query("UPDATE game_commands SET claimed_at = now() - interval '10 minutes', attempts = 3 WHERE id = $1", [cmd.id]);
	assert.equal((await queue.claim('C')).length, 0);
	assert.equal((await queue.get(cmd.id)).status, 'failed');
});

test('logs: auth, validation, clipping, event out', async () => {
	assert.equal((await postJson('/v1/roblox/logs', { logs: [] })).status, 400);
	assert.equal((await postJson('/v1/roblox/logs', { logs: [{ channel: 'panel', embed: { title: 'x' } }] }, 'bad'.padEnd(40, 'y'))).status, 401);
	const got = [];
	const on = (l) => got.push(...l);
	events.on('gameLogs', on);
	const r = await (await postJson('/v1/roblox/logs', { logs: [
		{ channel: 'anticheat', embed: { title: 'Kicked: x', color: 15158332, fields: [{ name: 'a', value: 'b'.repeat(5000), inline: true }] } },
		{ channel: 'nope', embed: { title: 'x' } },
		{ channel: 'panel', embed: {} },
	] })).json();
	events.off('gameLogs', on);
	assert.deepEqual(r, { accepted: 1, rejected: 2 });
	assert.equal(got.length, 1);
	assert.equal(got[0].embed.fields[0].value.length, 1024);
});

const boostRewards = require('../src/rewards/boost');

test('boost rewards: only current boosters, granted once per member and per Roblox account', async () => {
	const boosting = new Map([['111111', true], ['222222', true], ['333333', false]]);
	boostRewards.setVerifier(async (id) => boosting.get(id) ?? false);
	// A: linked booster. B: booster, not linked yet. C: stopped boosting before playing.
	assert.equal((await boostRewards.recordBooster('111111', 5001)).isNew, true);
	assert.equal((await boostRewards.recordBooster('111111', 5001)).isNew, false); // seen again: same row
	await boostRewards.recordBooster('222222', null);
	await boostRewards.recordBooster('333333', 5003);

	let r = await (await postJson('/v1/roblox/rewards/pending', { userIds: [5001, 5002, 5003] })).json();
	assert.deepEqual(r.rewards, [{ id: '111111', kind: 'boost', userId: 5001 }]); // B has no link, C isn't boosting
	assert.equal((await postJson('/v1/roblox/rewards/pending', { userIds: [-1] })).status, 400);
	assert.equal((await postJson('/v1/roblox/rewards/pending', { userIds: [1] }, 'x'.repeat(40))).status, 401);

	// B links later -> now pending for their account
	await boostRewards.recordBooster('222222', 5002);
	r = await (await postJson('/v1/roblox/rewards/pending', { userIds: [5002] })).json();
	assert.deepEqual(r.rewards.map((x) => x.id), ['222222']);

	// the game confirms A; a retry is fine; confirming for a different account is refused
	const granted = [];
	const on = (e) => granted.push(e);
	events.on('boostGranted', on);
	assert.equal((await (await postJson('/v1/roblox/rewards/confirm', { id: '111111', userId: 5001, serverId: 'S' })).json()).ok, true);
	assert.equal((await (await postJson('/v1/roblox/rewards/confirm', { id: '111111', userId: 5001, serverId: 'S' })).json()).ok, true);
	assert.equal((await (await postJson('/v1/roblox/rewards/confirm', { id: '111111', userId: 9999, serverId: 'S' })).json()).ok, false);
	events.off('boostGranted', on);
	assert.equal(granted.length, 1);
	r = await (await postJson('/v1/roblox/rewards/pending', { userIds: [5001] })).json();
	assert.equal(r.rewards.length, 0);

	// A switches their link after the grant: the reward stays where it went (no second copy)
	await boostRewards.recordBooster('111111', 7777);
	assert.equal(Number((await boostRewards.get('111111')).roblox_user_id), 5001);

	// another member linked to the SAME Roblox account can't get a second copy
	boosting.set('444444', true);
	await boostRewards.recordBooster('444444', 5001);
	r = await (await postJson('/v1/roblox/rewards/pending', { userIds: [5001] })).json();
	assert.equal(r.rewards.length, 0);
	assert.equal((await boostRewards.confirmGranted('444444', 5001)).newly, false);

	// Discord unreachable (verifier says unknown) -> nothing is handed out
	boostRewards.setVerifier(async () => null);
	r = await (await postJson('/v1/roblox/rewards/pending', { userIds: [5002] })).json();
	assert.equal(r.rewards.length, 0);
});
