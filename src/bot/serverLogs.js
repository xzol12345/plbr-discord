// Server logs (all posted through logChannels, never pinging anyone):
//   join-logs     every member joining the DISCORD server (the game posts its
//                 own joins there too - each embed says which one)
//   message-logs  every deleted or edited message in any chat (needs the
//                 Message Content Intent to know what the message said)
//   voice-logs    joins / leaves / moves between calls, server mute / deafen,
//                 self mute / deafen, camera and screen-share on / off
// Bots and the log channels themselves are skipped.
const { EmbedBuilder, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const logChannels = require('./logChannels');
const automod = require('./automod');

const clip = (s, n = 1000) => {
	const t = String(s ?? '');
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ts = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>`;
const inGuild = (g) => g && g.id === config.discordGuildId;

// ---------------------------------------------------------------- joins
function onMemberJoin(member) {
	if (!inGuild(member.guild)) return;
	const u = member.user;
	logChannels.push('joins', new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(`💬 Joined the DISCORD SERVER - ${u.tag}`)
		.setDescription('**Where:** the PL:BR Discord server')
		.setThumbnail(u.displayAvatarURL())
		.addFields(
			{ name: 'Member', value: `<@${u.id}>`, inline: true },
			{ name: 'User ID', value: u.id, inline: true },
			{ name: 'Account created', value: ts(u.createdAt), inline: true },
			{ name: 'Members now', value: String(member.guild.memberCount), inline: true },
			...(u.bot ? [{ name: 'Bot', value: 'yes', inline: true }] : []),
		)
		.setFooter({ text: 'Discord server join' })
		.setTimestamp());
}

// ---------------------------------------------------------------- messages
function skipMessage(m) {
	return !m.guild || !inGuild(m.guild) || m.author?.bot || m.webhookId || logChannels.isLogChannel(m.channelId);
}

function attachmentsText(m) {
	const list = [...(m.attachments?.values() || [])].map((a) => a.url);
	return list.length ? clip(list.join('\n'), 1000) : null;
}

function onMessageDelete(m) {
	if (skipMessage(m)) return;
	if (automod.removedReason(m.id)) return; // already logged by auto-moderation
	const e = new EmbedBuilder().setColor(0xed4245).setTitle('🗑️ Message deleted').setTimestamp();
	if (m.partial || m.author == null) {
		e.setDescription(`A message in <#${m.channelId}> was deleted (it was sent before the bot started, so its text isn't known).`);
	} else {
		e.setAuthor({ name: `${m.author.tag} (${m.author.id})`, iconURL: m.author.displayAvatarURL() })
			.addFields(
				{ name: 'Member', value: `<@${m.author.id}>`, inline: true },
				{ name: 'Channel', value: `<#${m.channelId}>`, inline: true },
				{ name: 'Sent', value: ts(m.createdAt), inline: true },
				{ name: 'Message', value: clip(m.content || '*(no text)*') },
			);
		const files = attachmentsText(m);
		if (files) e.addFields({ name: 'Attachments', value: files });
	}
	logChannels.push('messages', e);
}

function onMessageBulkDelete(messages, channel) {
	if (!channel?.guild || !inGuild(channel.guild) || logChannels.isLogChannel(channel.id)) return;
	const list = [...messages.values()].filter((m) => !m.author?.bot && !automod.removedReason(m.id));
	if (!list.length) return;
	const lines = list
		.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
		.map((m) => (m.author ? `**${m.author.tag}:** ${clip(m.content || '*(no text)*', 150)}` : '*(unknown message)*'));
	logChannels.push('messages', new EmbedBuilder()
		.setColor(0xed4245)
		.setTitle(`🗑️ ${list.length} messages deleted at once`)
		.setDescription(clip(`In <#${channel.id}>:\n${lines.join('\n')}`, 4000))
		.setTimestamp());
}

function onMessageUpdate(before, after) {
	if (skipMessage(after)) return;
	if (before.partial || before.content == null || before.content === after.content) return; // embeds loading, pins...
	logChannels.push('messages', new EmbedBuilder()
		.setColor(0xfee75c)
		.setTitle('✏️ Message edited')
		.setAuthor({ name: `${after.author.tag} (${after.author.id})`, iconURL: after.author.displayAvatarURL() })
		.addFields(
			{ name: 'Member', value: `<@${after.author.id}>`, inline: true },
			{ name: 'Channel', value: `<#${after.channelId}>`, inline: true },
			{ name: 'Jump', value: `[open message](${after.url})`, inline: true },
			{ name: 'Before', value: clip(before.content || '*(no text)*') },
			{ name: 'After', value: clip(after.content || '*(no text)*') },
		)
		.setTimestamp());
}

// ---------------------------------------------------------------- voice
// who did it (server mute / deafen / move / disconnect) - from the audit log
// when the bot may read it, otherwise left out
async function executorFor(guild, type, targetId) {
	if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
	try {
		const logs = await guild.fetchAuditLogs({ type, limit: 5 });
		const entry = logs.entries.find((e) => (!targetId || e.target?.id === targetId || e.extra?.channel) && Date.now() - e.createdTimestamp < 15_000);
		return entry?.executor ? `<@${entry.executor.id}>` : null;
	} catch {
		return null;
	}
}

async function onVoiceState(before, after) {
	const guild = after.guild || before.guild;
	if (!inGuild(guild)) return;
	const member = after.member || before.member;
	if (!member || member.user.bot) return;
	const who = `<@${member.id}>`;
	const events = [];
	if (!before.channelId && after.channelId) events.push({ c: 0x57f287, t: '🔊 Joined a call', d: `${who} joined <#${after.channelId}>` });
	else if (before.channelId && !after.channelId) {
		const by = await executorFor(guild, AuditLogEvent.MemberDisconnect);
		events.push({ c: 0xed4245, t: '🔇 Left a call', d: `${who} left <#${before.channelId}>${by ? ` (disconnected by ${by})` : ''}` });
	} else if (before.channelId !== after.channelId) {
		const by = await executorFor(guild, AuditLogEvent.MemberMove);
		events.push({ c: 0x5865f2, t: '🔀 Moved calls', d: `${who} moved from <#${before.channelId}> to <#${after.channelId}>${by ? ` (moved by ${by})` : ''}` });
	}
	const toggles = [
		['serverMute', '🔇 Server muted', '🔈 Server unmuted', true],
		['serverDeaf', '🙉 Server deafened', '👂 Server undeafened', true],
		['selfMute', '🎙️ Muted themselves', '🎙️ Unmuted themselves', false],
		['selfDeaf', '🎧 Deafened themselves', '🎧 Undeafened themselves', false],
		['selfVideo', '📷 Camera on', '📷 Camera off', false],
		['streaming', '🖥️ Started screen sharing', '🖥️ Stopped screen sharing', false],
	];
	if (before.channelId && after.channelId) {
		for (const [key, on, off, byStaff] of toggles) {
			if (Boolean(before[key]) === Boolean(after[key])) continue;
			let by = null;
			if (byStaff) by = await executorFor(guild, AuditLogEvent.MemberUpdate, member.id);
			events.push({ c: 0xfee75c, t: after[key] ? on : off, d: `${who} in <#${after.channelId}>${by ? ` (by ${by})` : ''}` });
		}
	}
	for (const ev of events) {
		logChannels.push('voice', new EmbedBuilder()
			.setColor(ev.c)
			.setTitle(ev.t)
			.setAuthor({ name: `${member.user.tag} (${member.id})`, iconURL: member.user.displayAvatarURL() })
			.setDescription(ev.d)
			.setTimestamp());
	}
}

module.exports = { onMemberJoin, onMessageDelete, onMessageBulkDelete, onMessageUpdate, onVoiceState };
