// Runs the farming detectors: soon after new kills / wins arrive (those
// players), every few minutes for everyone active recently, and every 6 hours
// a stat-ratio sweep of the top players (so existing all-time totals like
// "4 kills / 60 wins" are checked too, not only new activity). Detections go
// to the anti-cheat log channel ONLY. Never touches the game or the player.
const db = require('../db/pool');
const C = require('./config');
const detect = require('./detect');
const report = require('./report');
const ingest = require('./ingest');

const queued = new Set();
let running = false;
let getChannel = async () => null;

function queue(userIds) { for (const id of userIds) queued.add(id); }

async function scan(ids, now = Date.now()) {
	const channel = await getChannel();
	let posted = 0;
	for (const id of ids) {
		try {
			for (const inc of await detect.scanPlayer(id, now)) {
				const action = await report.publish(channel, inc, now);
				if (action !== 'none') {
					posted += 1;
					console.log(`[farming] ${action === 'new' ? 'new' : 'updated'} ${inc.severity} detection ${inc.key}`);
				}
			}
		} catch (err) {
			console.warn(`[farming] scan of ${id} failed: ${err.message}`);
		}
	}
	return posted;
}

async function tick() {
	if (running) return;
	running = true;
	try {
		const recent = (await db.query(
			`SELECT killer_id AS id FROM farm_kills WHERE at > now() - ($1 || ' minutes')::interval
			 UNION SELECT user_id FROM farm_wins WHERE at > now() - ($1 || ' minutes')::interval`,
			[String(C.scanEveryMinutes * 2)],
		)).rows.map((r) => Number(r.id));
		const ids = new Set([...queued, ...recent]);
		queued.clear();
		if (ids.size) await scan([...ids]);
	} catch (err) {
		console.warn('[farming] tick failed', err.message);
	} finally {
		running = false;
	}
}

async function sweep() {
	try {
		const top = (await db.query(
			`(SELECT roblox_user_id AS id FROM players ORDER BY wins DESC LIMIT 100)
			 UNION (SELECT roblox_user_id FROM players ORDER BY kills DESC LIMIT 100)`,
		)).rows.map((r) => Number(r.id));
		await scan(top);
		await ingest.trim(C.retentionDays);
	} catch (err) {
		console.warn('[farming] sweep failed', err.message);
	}
}

function start(channelGetter) {
	getChannel = channelGetter;
	setInterval(tick, C.scanEveryMinutes * 60_000).unref();
	setTimeout(sweep, 2 * 60_000).unref();
	setInterval(sweep, 6 * 3600_000).unref();
	console.log(`[farming] stat-farming detection running (scan every ${C.scanEveryMinutes} min, ${C.retentionDays}-day history) - logs only, never acts in game`);
}

module.exports = { start, queue, scan, tick };
