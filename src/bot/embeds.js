// PL:BR-branded embeds (graphite + the game's red-orange accent).
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const { KILL_TIERS, WIN_TIERS, tierFor, nextTier } = require('../stats/tiers');
const { formatKd } = require('../stats/kd');
const roblox = require('../services/roblox');

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const MEDALS = ['🥇', '🥈', '🥉'];

function base() {
	const e = new EmbedBuilder().setColor(config.brandColor).setTimestamp();
	return e.setFooter({ text: `${config.brandName} • stats sync from the game` });
}

async function statsEmbed(player, ranks) {
	const avatar = await roblox.getHeadshotUrl(player.userId);
	const killTier = tierFor(KILL_TIERS, player.kills);
	const winTier = tierFor(WIN_TIERS, player.wins);
	const e = base()
		.setAuthor({ name: `${config.brandName} STATS`, url: config.gameUrl || undefined })
		.setTitle(player.username)
		.setURL(roblox.profileUrl(player.userId))
		.addFields(
			{ name: '💀 Kills', value: `**${fmt(player.kills)}**`, inline: true },
			{ name: '🏆 Wins', value: `**${fmt(player.wins)}**`, inline: true },
			{ name: '☠️ Deaths', value: `**${fmt(player.deaths)}**`, inline: true },
			{ name: '🎯 K/D Ratio', value: `**${formatKd(player.kills, player.deaths)}**`, inline: true },
			{ name: '📈 Kill Rank', value: `**#${fmt(ranks.kills)}**`, inline: true },
			{ name: '📈 Win Rank', value: `**#${fmt(ranks.wins)}**`, inline: true },
			{ name: 'Ranks', value: WIN_TIERS.length ? `${killTier ? killTier.name : '—'} • ${winTier ? winTier.name : 'no win rank yet'}` : (killTier ? killTier.name : '—') },
		);
	if (avatar) e.setThumbnail(avatar);
	if (player.lastSyncedAt) e.setFooter({ text: `${config.brandName} • last synced` }).setTimestamp(new Date(player.lastSyncedAt));
	return e;
}

function progressLine(tiers, value, unit) {
	const cur = tierFor(tiers, value);
	const next = nextTier(tiers, value);
	const now = cur ? `**${cur.name}**` : '*none yet*';
	if (!next) return `${now} — top rank reached (${fmt(value)} ${unit})`;
	const from = cur ? cur.min : 0;
	const pct = Math.max(0, Math.min(1, (value - from) / (next.min - from)));
	const filled = Math.round(pct * 10);
	return `${now}\n\`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\` ${fmt(value)} / ${fmt(next.min)} ${unit} → **${next.name}**`;
}

async function rankEmbed(player) {
	const avatar = await roblox.getHeadshotUrl(player.userId);
	const e = base()
		.setAuthor({ name: `${config.brandName} RANKS` })
		.setTitle(player.username)
		.setURL(roblox.profileUrl(player.userId))
		.addFields({ name: '💀 Kill progression', value: progressLine(KILL_TIERS, player.kills, 'kills') });
	if (WIN_TIERS.length) e.addFields({ name: '🏆 Win progression', value: progressLine(WIN_TIERS, player.wins, 'wins') });
	if (avatar) e.setThumbnail(avatar);
	return e;
}

function leaderboardEmbed(stat, players) {
	const title = stat === 'kills' ? '💀 KILL LEADERBOARD' : '🏆 WIN LEADERBOARD';
	const lines = players.length
		? players.map((p, i) => {
			const place = MEDALS[i] || `\`#${String(i + 1).padStart(2, ' ')}\``;
			const value = stat === 'kills' ? p.kills : p.wins;
			return `${place} **${p.username}** — ${fmt(value)} ${stat}`;
		}).join('\n')
		: '*No players yet — get in a match!*';
	return base()
		.setAuthor({ name: config.brandName })
		.setTitle(title)
		.setDescription(lines)
		.setFooter({ text: `${config.brandName} • Top 10 • updates automatically` });
}

function infoEmbed(title, description) {
	return base().setTitle(title).setDescription(description);
}

function errorEmbed(description) {
	return new EmbedBuilder().setColor(0xff5252).setTitle('Something went wrong').setDescription(description);
}

module.exports = { statsEmbed, rankEmbed, leaderboardEmbed, infoEmbed, errorEmbed };
