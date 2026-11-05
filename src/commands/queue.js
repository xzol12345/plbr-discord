// Discord -> game command queue (Postgres). Game servers poll /v1/roblox/commands/claim;
// a claim is atomic (FOR UPDATE SKIP LOCKED), so one command runs on ONE server.
// A claim that never reports back (server crashed) is handed out again after
// CLAIM_TIMEOUT, at most MAX_ATTEMPTS times. The game also de-duplicates by
// command id, so a re-run can't ban twice.
const db = require('../db/pool');
const events = require('../events');

const CLAIM_TIMEOUT_SECONDS = 120;
const MAX_ATTEMPTS = 3;
const KINDS = new Set(['ban']);

function toCommand(r) {
	return r && {
		id: Number(r.id), kind: r.kind, payload: r.payload, status: r.status, attempts: r.attempts,
		result: r.result, requestedBy: r.requested_by, createdAt: r.created_at,
	};
}

async function enqueue(kind, payload, requestedBy) {
	if (!KINDS.has(kind)) throw new Error(`unknown command ${kind}`);
	const r = await db.query(
		'INSERT INTO game_commands (kind, payload, requested_by) VALUES ($1, $2, $3) RETURNING *',
		[kind, JSON.stringify(payload), requestedBy],
	);
	return toCommand(r.rows[0]);
}

async function claim(serverId, limit = 5) {
	// commands claimed too many times without an answer are given up on
	await db.query(
		`UPDATE game_commands SET status = 'failed', finished_at = now(),
		   result = '{"ok":false,"message":"No game server finished this command"}'::jsonb
		 WHERE status = 'claimed' AND attempts >= $1 AND claimed_at < now() - ($2 || ' seconds')::interval`,
		[MAX_ATTEMPTS, String(CLAIM_TIMEOUT_SECONDS)],
	);
	const r = await db.query(
		`UPDATE game_commands SET status = 'claimed', claimed_by = $1, claimed_at = now(), attempts = attempts + 1
		 WHERE id IN (
		   SELECT id FROM game_commands
		   WHERE status = 'pending'
		      OR (status = 'claimed' AND attempts < $3 AND claimed_at < now() - ($4 || ' seconds')::interval)
		   ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
		 RETURNING *`,
		[String(serverId).slice(0, 64), limit, MAX_ATTEMPTS, String(CLAIM_TIMEOUT_SECONDS)],
	);
	return r.rows.map(toCommand).sort((a, b) => a.id - b.id);
}

// Only the server that holds the claim may finish it; a late answer for a
// command that's already finished is ignored (returns null).
async function finish(id, serverId, ok, message) {
	const result = { ok: ok === true, message: String(message ?? '').slice(0, 500) };
	const r = await db.query(
		`UPDATE game_commands SET status = $3, result = $4, finished_at = now()
		 WHERE id = $1 AND status = 'claimed' AND claimed_by = $2 RETURNING *`,
		[id, String(serverId).slice(0, 64), result.ok ? 'done' : 'failed', JSON.stringify(result)],
	);
	const cmd = toCommand(r.rows[0]);
	if (cmd) events.emit('commandFinished', cmd);
	return cmd;
}

async function get(id) {
	return toCommand((await db.query('SELECT * FROM game_commands WHERE id = $1', [id])).rows[0]);
}

// resolves with the finished command, or null after timeoutMs
function waitFor(id, timeoutMs) {
	return new Promise((resolve) => {
		const onDone = (cmd) => {
			if (cmd.id !== id) return;
			clearTimeout(timer);
			events.off('commandFinished', onDone);
			resolve(cmd);
		};
		const timer = setTimeout(() => {
			events.off('commandFinished', onDone);
			resolve(null);
		}, timeoutMs);
		events.on('commandFinished', onDone);
	});
}

module.exports = { enqueue, claim, finish, get, waitFor, CLAIM_TIMEOUT_SECONDS, MAX_ATTEMPTS };
