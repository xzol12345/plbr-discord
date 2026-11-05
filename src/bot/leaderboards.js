// Keeps ONE leaderboard message per channel up to date. The message id is
// remembered in the database, so after a restart the bot edits the same
// message instead of posting a new one. Messages are only edited when the
// top 10 actually changed.
const crypto = require('node:crypto');
const db = require('../db/pool');
const config = require('../config');
const store = require('../stats/store');
const embeds = require('./embeds');

const BOARDS = [
	{ stat: 'kills', channel: () => config.killLeaderboardChannelId },
	{ stat: 'wins', channel: () => config.winLeaderboardChannelId },
];

async function getState(key) {
	const r = await db.query('SELECT value FROM bot_state WHERE key = $1', [key]);
	return r.rows[0]?.value ?? null;
}

async function setState(key, value) {
	await db.query(
		`INSERT INTO bot_state (key, value, updated_at) VALUES ($1, $2, now())
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		[key, JSON.stringify(value)],
	);
}

async function updateOne(client, board, force) {
	const channelId = board.channel();
	if (!channelId) return;
	const players = await store.top(board.stat, 10);
	const hash = crypto.createHash('sha1').update(JSON.stringify(players.map((p) => [p.userId, p.username, p[board.stat]]))).digest('hex');
	const key = `leaderboard:${board.stat}`;
	const state = (await getState(key)) || {};
	if (!force && state.hash === hash && state.channelId === channelId && state.messageId) return;

	const channel = await client.channels.fetch(channelId).catch(() => null);
	if (!channel?.isTextBased()) {
		console.warn(`[leaderboard] channel ${channelId} for ${board.stat} not found or not a text channel`);
		return;
	}
	const payload = { embeds: [embeds.leaderboardEmbed(board.stat, players)] };
	let message = null;
	if (state.messageId && state.channelId === channelId) {
		message = await channel.messages.fetch(state.messageId).catch(() => null);
	}
	if (message) await message.edit(payload);
	else message = await channel.send(payload);
	await setState(key, { channelId, messageId: message.id, hash });
}

async function update(client, { force = false } = {}) {
	for (const board of BOARDS) {
		try {
			await updateOne(client, board, force);
		} catch (err) {
			console.error(`[leaderboard] ${board.stat}:`, err.message);
		}
	}
}

module.exports = { update };
