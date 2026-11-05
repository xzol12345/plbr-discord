// /nuke - administrators only. Wipes a channel's history by re-creating it:
// the bot clones the channel (same name, topic, category, permission
// overwrites, slowmode, NSFW flag...), moves the copy to the exact same
// position, and only THEN deletes the original. If anything goes wrong before
// the delete, the original channel is left untouched.
const {
	ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType,
	MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const config = require('../config');
const embeds = require('./embeds');

const NUKEABLE = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const CONFIRM_MS = 30_000;

// Why a channel can't be nuked, or null if it can.
function blockedReason(channel, guild) {
	if (!channel || !NUKEABLE.has(channel.type)) return 'Only text and announcement channels can be nuked (not threads, voice or forum channels).';
	if (channel.id === guild.rulesChannelId) return 'This is the server\'s **Rules** channel. Discord doesn\'t allow deleting it.';
	if (channel.id === guild.publicUpdatesChannelId) return 'This is the server\'s **Community Updates** channel. Discord doesn\'t allow deleting it.';
	if ([config.killLeaderboardChannelId, config.winLeaderboardChannelId].includes(channel.id)) {
		return 'This is a **leaderboard channel**. Nuking it would change its ID and break the auto-updating leaderboard. Use **/leaderboard-refresh** instead.';
	}
	const me = guild.members.me;
	const perms = channel.permissionsFor(me);
	if (!perms?.has(PermissionFlagsBits.ManageChannels)) {
		return 'I need the **Manage Channels** permission for this. Server Settings → Roles → **PLBR** → turn on **Manage Channels**.';
	}
	if (!channel.deletable) return 'I can\'t delete this channel. My role might be missing **Manage Channels** here.';
	return null;
}

async function recreate(channel, actor) {
	const reason = `/nuke by ${actor.tag} (${actor.id})`;
	const position = channel.rawPosition;
	// 1. copy (keeps the permission overwrites, topic, category, slowmode...)
	const copy = await channel.clone({ reason });
	// 2. put the copy exactly where the original is
	await copy.setPosition(position, { reason }).catch(() => null);
	// 3. only now remove the original
	await channel.delete(reason);
	// deleting shifts the positions below it - pin the copy once more
	await copy.setPosition(position, { reason }).catch(() => null);
	return copy;
}

async function nuke(i) {
	if (!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
		return i.reply({ embeds: [embeds.infoEmbed('Administrators only', 'Only server administrators can use **/nuke**.')], flags: MessageFlags.Ephemeral });
	}
	const channel = i.channel;
	const why = blockedReason(channel, i.guild);
	if (why) return i.reply({ embeds: [embeds.infoEmbed('Can\'t nuke this channel', why)], flags: MessageFlags.Ephemeral });

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId('nuke:confirm').setLabel('Nuke it').setEmoji('💥').setStyle(ButtonStyle.Danger),
		new ButtonBuilder().setCustomId('nuke:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
	);
	await i.deferReply({ flags: MessageFlags.Ephemeral });
	const prompt = await i.editReply({
		embeds: [embeds.infoEmbed('💥 Nuke this channel?', `<#${channel.id}> will be **deleted and re-created** in the same spot with the same permissions.\n\nEvery message in it is gone for good. This can't be undone.`)],
		components: [row],
	});

	let press;
	try {
		press = await prompt.awaitMessageComponent({ componentType: ComponentType.Button, filter: (b) => b.user.id === i.user.id, time: CONFIRM_MS });
	} catch {
		return i.editReply({ embeds: [embeds.infoEmbed('Nuke cancelled', 'No answer within 30 seconds - nothing was changed.')], components: [] }).catch(() => null);
	}
	if (press.customId !== 'nuke:confirm') {
		return press.update({ embeds: [embeds.infoEmbed('Nuke cancelled', 'Nothing was changed.')], components: [] });
	}
	await press.update({ embeds: [embeds.infoEmbed('💥 Nuking…', 'Re-creating the channel.')], components: [] });

	let copy;
	try {
		copy = await recreate(channel, i.user);
	} catch (err) {
		console.warn(`[nuke] #${channel.name} failed: ${err.message}`);
		const hint = err.code === 50013
			? 'I\'m missing a permission that this channel\'s overrides use. Discord only lets a bot copy overrides for permissions it has itself. Giving the **PLBR** role **Administrator** fixes this.'
			: 'Please try again in a moment.';
		// the original is only deleted last, so it's still here
		return i.editReply({ embeds: [embeds.errorEmbed(`Couldn't nuke <#${channel.id}>. The channel was **not** deleted.\n${hint}`)] }).catch(() => null);
	}
	console.log(`[nuke] #${copy.name} re-created by ${i.user.tag}`);
	await copy.send({ embeds: [embeds.infoEmbed('💥 Channel nuked', `This channel was reset by <@${i.user.id}>.`)] }).catch(() => null);
	// the ephemeral prompt lived in the deleted channel, so it's gone - nothing more to edit
	return null;
}

module.exports = { nuke, blockedReason };
