// HTTP API for Roblox game servers. Server-to-server only:
//   POST /v1/roblox/stats   { players: [ { userId, username, kills, wins, deaths, revision } ] }
//   GET  /health
// Auth: "Authorization: Bearer <key>" where <key> is one of ROBLOX_SYNC_KEYS.
// The game sends ABSOLUTE saved totals + a forward-only revision, so
// retries, duplicates and out-of-order requests can never inflate stats.
const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const store = require('../stats/store');

const MAX_BATCH = 100;

function keyMatches(given) {
	if (typeof given !== 'string' || given.length < 32) return false;
	const g = crypto.createHash('sha256').update(given).digest();
	let ok = false;
	for (const key of config.robloxSyncKeys) {
		const k = crypto.createHash('sha256').update(key).digest();
		if (crypto.timingSafeEqual(g, k)) ok = true;
	}
	return ok;
}

// tiny fixed-window limiter per IP (Roblox servers batch, so this is generous)
function rateLimit(limit, windowMs) {
	const hits = new Map();
	setInterval(() => hits.clear(), windowMs).unref();
	return (req, res, next) => {
		const n = (hits.get(req.ip) || 0) + 1;
		hits.set(req.ip, n);
		if (n > limit) return res.status(429).json({ error: 'rate limited' });
		next();
	};
}

function requireGameKey(req, res, next) {
	const header = req.get('authorization') || '';
	const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
	if (!config.robloxSyncKeys.length) return res.status(503).json({ error: 'sync not configured' });
	if (!keyMatches(token)) {
		console.warn(`[api] rejected a stats request with a ${token ? 'wrong' : 'missing'} key`);
		return res.status(401).json({ error: 'unauthorized' });
	}
	next();
}

function createApp() {
	const app = express();
	app.disable('x-powered-by');
	app.set('trust proxy', 1); // Railway sits behind one proxy

	app.get('/health', (req, res) => res.json({ ok: true }));

	app.post(
		'/v1/roblox/stats',
		rateLimit(600, 60_000),
		requireGameKey,
		express.json({ limit: '64kb' }),
		async (req, res) => {
			const list = Array.isArray(req.body?.players) ? req.body.players : null;
			if (!list || list.length === 0 || list.length > MAX_BATCH) {
				return res.status(400).json({ error: `players must be an array of 1-${MAX_BATCH}` });
			}
			const results = [];
			for (const raw of list) {
				const v = store.validateUpdate(raw);
				if (!v.ok) {
					results.push({ userId: raw?.userId ?? null, outcome: 'invalid', error: v.error });
					continue;
				}
				try {
					results.push({ userId: v.value.userId, outcome: await store.applyUpdate(v.value, 'game') });
				} catch (err) {
					console.error('[api] apply failed', err.message);
					results.push({ userId: v.value.userId, outcome: 'error' });
				}
			}
			// 'stale' and 'rejected' are final answers (the game must not retry
			// them); only 'error' is worth retrying.
			const counts = {};
			for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
			console.log(`[api] stats batch of ${results.length}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
			res.json({ results });
		},
	);

	app.use((err, req, res, next) => {
		if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid json' });
		if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too large' });
		console.error('[api] unexpected', err);
		res.status(500).json({ error: 'server error' });
	});

	app.use((req, res) => res.status(404).json({ error: 'not found' }));
	return app;
}

module.exports = { createApp };
