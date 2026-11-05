// Slash commands. Statistics are READ-ONLY here - nothing a Discord user
// does can change kills / wins / deaths; they only come from the game.
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../config');
const store = require('../stats/store');
const linking = require('./linking');
const roles = require('./roles');
const embeds = require('./embeds');
const leaderboards = require('./leaderboards');
const reconcile = require('../sync/reconcile');
const { BloxlinkError } = require('../services/bloxlink');
const { nuke } = require('./nuke');
const { ban } = require('./ban');

const definitions = [
	new SlashCommandBuilder().setName('stats').setDescription('View PL:BR statistics')
		.addUserOption((o) => o.setName('player').setDescription('Another member (leave empty for yourself)'))
		.addStringOption((o) => o.setName('roblox').setDescription('Or a Roblox username').setMaxLength(20)),
	new SlashCommandBuilder().setName('leaderboard').setDescription('Top 10 PL:BR players')
		.addStringOption((o) => o.setName('type').setDescription('Kills or wins').setRequired(true)
			.addChoices({ name: 'kills', value: 'kills' }, { name: 'wins', value: 'wins' })),
	new SlashCommandBuilder().setName('rank').setDescription('Your PL:BR Discord ranks and next milestones'),
	new SlashCommandBuilder().setName('refresh').setDescription('Refresh your PL:BR stats and Discord roles'),
	new SlashCommandBuilder().setName('link').setDescription('Link your Roblox account (through Bloxlink)'),
	new SlashCommandBuilder().setName('leaderboard-refresh').setDescription('Re-post / update the leaderboard channels now')
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
	new SlashCommandBuilder().setName('ban').setDescription('Admins: ban a player in PL:BR (the game)')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.addStringOption((o) => o.setName('player').setDescription('Their Roblox username').setRequired(true).setMinLength(3).setMaxLength(20))
		.addStringOption((o) => o.setName('reason').setDescription('Why (shown to them on the ban screen)').setRequired(true).setMaxLength(120))
		.addStringOption((o) => o.setName('type').setDescription('Normal Ban (default) or In-Game Ban (lobby only)')
			.addChoices({ name: 'Normal Ban', value: 'normal' }, { name: 'In-Game Ban (lobby only)', value: 'ingame' })),
	new SlashCommandBuilder().setName('nuke').setDescription('Admins: wipe this channel by re-creating it with the same settings')
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

const NOT_LINKED = 'You haven\'t verified a Roblox account with **Bloxlink** in this server yet.\nUse **/link** to see how - it takes about a minute.';

// cooldowns for the commands that call external APIs
const cooldown = new Map();
function onCooldown(key, ms) {
	const t = cooldown.get(key) || 0;
	if (Date.now() - t < ms) return true;
	cooldown.set(key, Date.now());
	return false;
}

async function playerFor(robloxId) {
	return (await store.getPlayer(robloxId)) || (await reconcile.refreshFromOpenCloud(robloxId).catch(() => null));
}

async function ranksFor(p) {
	return { kills: await store.rankOf('kills', p.kills), wins: await store.rankOf('wins', p.wins) };
}

const handlers = {
	async stats(i) {
		await i.deferReply();
		const target = i.options.getUser('player');
		const robloxName = i.options.getString('roblox');
		let player;
		if (robloxName) {
			player = await store.getPlayerByUsername(robloxName);
			if (!player) return i.editReply({ embeds: [embeds.infoEmbed('No stats found', `No synced PL:BR stats for **${robloxName}** yet.`)] });
		} else {
			const who = target || i.user;
			const robloxId = (await linking.storedRobloxId(who.id)) || (await linking.resolve(who.id));
			if (!robloxId) {
				return i.editReply({ embeds: [embeds.infoEmbed('Not linked', who.id === i.user.id ? NOT_LINKED : `<@${who.id}> hasn't verified a Roblox account with Bloxlink.`)] });
			}
			player = await playerFor(robloxId);
			if (!player) return i.editReply({ embeds: [embeds.infoEmbed('No stats yet', 'No PL:BR stats have synced for this account yet - play a match and they\'ll show up here.')] });
		}
		return i.editReply({ embeds: [await embeds.statsEmbed(player, await ranksFor(player))] });
	},

	async leaderboard(i) {
		const stat = i.options.getString('type', true);
		await i.deferReply();
		return i.editReply({ embeds: [embeds.leaderboardEmbed(stat, await store.top(stat, 10))] });
	},

	async rank(i) {
		await i.deferReply({ flags: MessageFlags.Ephemeral });
		const robloxId = (await linking.storedRobloxId(i.user.id)) || (await linking.resolve(i.user.id));
		if (!robloxId) return i.editReply({ embeds: [embeds.infoEmbed('Not linked', NOT_LINKED)] });
		const player = await playerFor(robloxId);
		if (!player) return i.editReply({ embeds: [embeds.infoEmbed('No stats yet', 'Play a PL:BR match and your ranks will appear here.')] });
		return i.editReply({ embeds: [await embeds.rankEmbed(player)] });
	},

	async refresh(i) {
		await i.deferReply({ flags: MessageFlags.Ephemeral });
		if (onCooldown(`refresh:${i.user.id}`, 60_000)) {
			return i.editReply({ embeds: [embeds.infoEmbed('Slow down', 'You can refresh once a minute.')] });
		}
		const robloxId = await linking.resolve(i.user.id, { fresh: true });
		if (!robloxId) {
			await roles.clearMember(i.guild, i.user.id);
			return i.editReply({ embeds: [embeds.infoEmbed('Not linked', NOT_LINKED)] });
		}
		const player = (await reconcile.refreshFromOpenCloud(robloxId).catch(() => null)) || (await store.getPlayer(robloxId));
		if (!player) return i.editReply({ embeds: [embeds.infoEmbed('No stats yet', 'Your Roblox account is linked, but no PL:BR stats have synced yet - play a match!')] });
		const r = await roles.syncMember(i.guild, i.user.id, player);
		const changes = [
			r.added.length ? `Added: **${r.added.join(', ')}**` : null,
			r.removed.length ? `Removed: ${r.removed.join(', ')}` : null,
			r.blocked?.length ? `⚠️ I can't manage: ${r.blocked.join(', ')} (my role must be above them)` : null,
		].filter(Boolean).join('\n') || 'Your roles were already up to date.';
		return i.editReply({ embeds: [embeds.infoEmbed(`Refreshed — ${player.username}`, changes), await embeds.statsEmbed(player, await ranksFor(player))] });
	},

	async link(i) {
		await i.deferReply({ flags: MessageFlags.Ephemeral });
		let robloxId = null;
		try { robloxId = await linking.resolve(i.user.id, { fresh: true }); } catch (err) { if (!(err instanceof BloxlinkError)) throw err; }
		if (robloxId) {
			const player = await playerFor(robloxId);
			if (player) await roles.syncMember(i.guild, i.user.id, player);
			return i.editReply({ embeds: [embeds.infoEmbed('✅ Linked', `You're verified as Roblox user **${player?.username || robloxId}** (ID \`${robloxId}\`).\nTo switch accounts, run Bloxlink's **/verify** again, then **/refresh** here.`)] });
		}
		return i.editReply({ embeds: [embeds.infoEmbed('🔗 Link your Roblox account', [
			'PL:BR uses **Bloxlink** to verify accounts:',
			'1. Run **/verify** (Bloxlink\'s command) in this server, or go to **https://blox.link/verify**.',
			'2. Sign in with Discord and pick the Roblox account you play PL:BR on.',
			'3. Come back and run **/refresh** - your stats and roles appear right away.',
			'',
			'Your Roblox **UserId** is what links you, so changing your Roblox username later is fine.',
		].join('\n'))] });
	},

	nuke,
	ban,

	async 'leaderboard-refresh'(i) {
		await i.deferReply({ flags: MessageFlags.Ephemeral });
		await leaderboards.update(i.client, { force: true });
		return i.editReply({ embeds: [embeds.infoEmbed('Leaderboards updated', 'Both leaderboard messages are up to date.')] });
	},
};

async function handle(interaction) {
	if (!interaction.isChatInputCommand()) return;
	if (interaction.guildId !== config.discordGuildId) return;
	const fn = handlers[interaction.commandName];
	if (!fn) return;
	try {
		await fn(interaction);
	} catch (err) {
		console.error(`[bot] /${interaction.commandName} failed`, err);
		const msg = err instanceof BloxlinkError ? err.message : 'Please try again in a moment.';
		const payload = { embeds: [embeds.errorEmbed(msg)] };
		try {
			if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
			else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
		} catch { /* interaction expired */ }
	}
}

module.exports = { definitions, handle };
