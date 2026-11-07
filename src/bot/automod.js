// Auto-moderation: removes Discord invite links + slurs (moderation/filter.js)
// and spam (the same message 3+ times in a minute -> ALL of that member's
// recent messages are deleted). The server owner, administrators and members
// with Manage Server are never moderated; bots are ignored.
// Needs the Message Content Intent (Developer Portal) to read messages and
// the Manage Messages permission to delete them.
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const config = require('../config');
const filter = require('../moderation/filter');
const { SpamTracker } = require('../moderation/spam');
const logChannels = require('./logChannels');

const spam = new SpamTracker({ repeats: Math.max(2, config.spamRepeats), windowMs: Math.max(10, config.spamWindowSeconds) * 1000 });
setInterval(() => spam.sweep(), 60_000).unref();

// ids the bot itself removed (so the message log can say why instead of "deleted")
const removedByBot = new Map(); // messageId -> reason
function noteRemoved(id, reason) {
	removedByBot.set(id, reason);
	setTimeout(() => removedByBot.delete(id), 60_000).unref();
}

function isExempt(member, guild) {
	if (!member) return false;
	if (guild && member.id === guild.ownerId) return true;
	return member.permissions?.has(PermissionFlagsBits.Administrator) || member.permissions?.has(PermissionFlagsBits.ManageGuild);
}

const lastWarn = new Map(); // userId -> time (one heads-up DM a minute at most)
async function warnUser(user, text) {
	const t = lastWarn.get(user.id) || 0;
	if (Date.now() - t < 60_000) return;
	lastWarn.set(user.id, Date.now());
	await user.send({ embeds: [new EmbedBuilder().setColor(0xff5252).setTitle('Message removed').setDescription(text)] }).catch(() => null);
}

function modLog(message, reason, extra) {
	logChannels.push('messages', new EmbedBuilder()
		.setColor(0xff5252)
		.setTitle(`🛡️ Auto-moderation: ${reason}`)
		.setAuthor({ name: `${message.author.tag} (${message.author.id})`, iconURL: message.author.displayAvatarURL() })
		.addFields(
			{ name: 'Member', value: `<@${message.author.id}>`, inline: true },
			{ name: 'Channel', value: `<#${message.channelId}>`, inline: true },
			{ name: 'Message', value: (message.content || '*(no text)*').slice(0, 1000) },
			...(extra ? [{ name: 'Details', value: extra }] : []),
		)
		.setTimestamp());
}

async function handleMessage(message) {
	if (!message.guild || message.guild.id !== config.discordGuildId || message.author?.bot || message.webhookId) return;
	if (logChannels.isLogChannel(message.channelId)) return;
	const member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
	if (isExempt(member, message.guild)) return;

	// 1) invite links / offensive language
	const hit = filter.check(message.content);
	if (hit) {
		noteRemoved(message.id, hit.reason);
		const ok = await message.delete().then(() => true).catch((err) => {
			console.warn(`[automod] couldn't delete a message in #${message.channel?.name}: ${err.message} (needs Manage Messages)`);
			return false;
		});
		if (ok) {
			modLog(message, hit.reason);
			warnUser(message.author, hit.reason === 'Discord invite link'
				? `Your message in **${message.guild.name}** was removed: Discord invite links aren't allowed.`
				: `Your message in **${message.guild.name}** was removed: offensive language isn't allowed.`);
		}
		return;
	}

	// 2) spam: the same message N times
	const toDelete = spam.add(message.author.id, { id: message.id, channelId: message.channelId, key: filter.spamKey(message.content) });
	if (!toDelete) return;
	const byChannel = new Map();
	for (const m of toDelete) {
		if (!byChannel.has(m.channelId)) byChannel.set(m.channelId, []);
		byChannel.get(m.channelId).push(m.id);
		noteRemoved(m.id, 'Spam');
	}
	let removed = 0;
	for (const [channelId, ids] of byChannel) {
		const channel = message.guild.channels.cache.get(channelId);
		if (!channel?.isTextBased()) continue;
		try {
			if (ids.length === 1) { await channel.messages.delete(ids[0]); removed += 1; } else {
				const done = await channel.bulkDelete(ids, true);
				removed += done.size;
			}
		} catch (err) {
			console.warn(`[automod] spam cleanup in #${channel.name} failed: ${err.message}`);
		}
	}
	modLog(message, 'Spam', `Sent the same message ${spam.repeats}+ times within ${Math.round(spam.windowMs / 1000)}s - removed ${removed} of their recent message(s).`);
	warnUser(message.author, `Your recent messages in **${message.guild.name}** were removed for spam (the same message ${spam.repeats}+ times).`);
}

module.exports = { handleMessage, isExempt, removedReason: (id) => removedByBot.get(id) || null };
