// /ban - administrators only. Bans a Roblox player IN THE GAME through the
// game's own ban system (BanService - the same one the Owner / Admin panels
// use). Discord can't reach Roblox servers directly, so the ban is queued in
// the database; a running game server claims it (exactly one does), bans the
// player, and reports back. With no server running it waits until one starts.
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const queue = require('../commands/queue');
const embeds = require('./embeds');

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const WAIT_MS = 25_000;
const TYPES = { normal: 'Normal Ban', ingame: 'In-Game Ban' };

function validate(name, reason, type) {
	if (!USERNAME_RE.test(name || '')) return 'That isn\'t a valid Roblox username (3-20 letters, numbers or _).';
	if (!reason || !reason.trim()) return 'A reason is required.';
	if (!TYPES[type]) return 'Unknown ban type.';
	return null;
}

async function ban(i) {
	if (!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
		return i.reply({ embeds: [embeds.infoEmbed('Administrators only', 'Only server administrators can use **/ban**.')], flags: MessageFlags.Ephemeral });
	}
	const name = i.options.getString('player', true).trim();
	const reason = i.options.getString('reason', true).replace(/\s+/g, ' ').trim();
	const type = i.options.getString('type') || 'normal';
	const bad = validate(name, reason, type);
	if (bad) return i.reply({ embeds: [embeds.infoEmbed('Can\'t ban', bad)], flags: MessageFlags.Ephemeral });

	await i.deferReply({ flags: MessageFlags.Ephemeral });
	const by = `${i.user.username} (Discord)`;
	const cmd = await queue.enqueue('ban', { username: name, reason, type, by, discordId: i.user.id }, i.user.id);
	console.log(`[ban] #${cmd.id} ${i.user.tag} -> ${name} (${type}): ${reason}`);
	await i.editReply({ embeds: [embeds.infoEmbed('⏳ Banning…', `Sending the ban for **${name}** to the game…`)] });

	const done = await queue.waitFor(cmd.id, WAIT_MS);
	if (!done) {
		return i.editReply({ embeds: [embeds.infoEmbed('🕒 Ban queued', `No game server has picked up the ban for **${name}** yet (there may be no servers running). It will be carried out as soon as one starts, and the result will be posted in the Manual log channel.`)] }).catch(() => null);
	}
	const title = done.result.ok ? `🔨 ${TYPES[type]}: ${name}` : `❌ Couldn't ban ${name}`;
	return i.editReply({ embeds: [embeds.infoEmbed(title, done.result.message || '(no details)')] }).catch(() => null);
}

// the Manual-channel log entry for a finished Discord ban
function resultLog(cmd) {
	const p = cmd.payload || {};
	const ok = cmd.result?.ok === true;
	return {
		title: ok ? `🔨 Discord /ban — ${p.username}` : `❌ Discord /ban failed — ${p.username}`,
		color: ok ? 0xe74c3c : 0x95a5a6,
		fields: [
			{ name: 'Player', value: String(p.username || '?'), inline: true },
			{ name: 'Type', value: TYPES[p.type] || String(p.type), inline: true },
			{ name: 'By', value: `<@${p.discordId}>`, inline: true },
			{ name: 'Reason', value: String(p.reason || '-').slice(0, 1000), inline: false },
			{ name: 'Result', value: String(cmd.result?.message || '-').slice(0, 1000), inline: false },
		],
		timestamp: new Date().toISOString(),
	};
}

module.exports = { ban, resultLog, validate, TYPES };
