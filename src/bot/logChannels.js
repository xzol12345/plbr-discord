// Posts game logs (anti-cheat kicks, staff panel actions, /ban results) to
// their Discord channels. Channels come from ANTICHEAT_LOG_CHANNEL /
// PANEL_LOG_CHANNEL - a channel ID or an exact channel name; when unset, the
// first text channel whose name contains "anti" + "cheat" / "manual" is used.
// Up to 10 embeds go out per message, and no log can ping anyone.
const { ChannelType } = require('discord.js');
const config = require('../config');

const KINDS = {
	anticheat: { setting: () => config.anticheatLogChannel, guess: (n) => n.includes('anti') && n.includes('cheat'), label: 'ANTICHEAT_LOG_CHANNEL' },
	panel: { setting: () => config.panelLogChannel, guess: (n) => n.includes('manual'), label: 'PANEL_LOG_CHANNEL' },
	joins: { setting: () => config.joinLogChannel, guess: (n) => n.includes('join') && n.includes('log'), label: 'JOIN_LOG_CHANNEL' },
	messages: { setting: () => config.messageLogChannel, guess: (n) => n.includes('message') && n.includes('log'), label: 'MESSAGE_LOG_CHANNEL' },
	voice: { setting: () => config.voiceLogChannel, guess: (n) => n.includes('voice') && n.includes('log'), label: 'VOICE_LOG_CHANNEL' },
};

const channelIds = {}; // kind -> channel id
const queues = { anticheat: [], panel: [], joins: [], messages: [], voice: [] };
let client = null;
let flushing = false;
const MAX_QUEUE = 300;

function pick(guild, kind) {
	const { setting, guess } = KINDS[kind];
	const text = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
	const want = setting();
	if (want) {
		return text.get(want) || text.find((c) => c.name.toLowerCase() === String(want).toLowerCase().replace(/^#/, '')) || null;
	}
	return text.sort((a, b) => a.rawPosition - b.rawPosition).find((c) => guess(c.name.toLowerCase())) || null;
}

async function setup(c, guild) {
	client = c;
	await guild.channels.fetch();
	for (const kind of Object.keys(KINDS)) {
		const ch = pick(guild, kind);
		if (ch) {
			channelIds[kind] = ch.id;
			const perms = ch.permissionsFor(guild.members.me);
			const canSend = perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks']);
			console.log(`[logs] ${kind} logs -> #${ch.name} (${ch.id})${canSend ? '' : ' - WARNING: I can\'t view/send/embed there, give the PLBR role access'}`);
		} else {
			delete channelIds[kind];
			console.warn(`[logs] no channel found for ${kind} logs - set ${KINDS[kind].label} to the channel ID or name`);
		}
	}
	flush();
}

function push(kind, embed) {
	const q = queues[kind];
	if (!q) return;
	q.push(embed);
	while (q.length > MAX_QUEUE) q.shift(); // a long outage keeps only the newest
	flush();
}

async function flush() {
	if (flushing || !client) return;
	flushing = true;
	try {
		for (const kind of Object.keys(queues)) {
			const q = queues[kind];
			if (!q.length || !channelIds[kind]) continue;
			const channel = await client.channels.fetch(channelIds[kind]).catch(() => null);
			if (!channel?.isTextBased()) continue;
			while (q.length) {
				const batch = q.slice(0, 10);
				try {
					await channel.send({ embeds: batch, allowedMentions: { parse: [] } });
					q.splice(0, batch.length);
				} catch (err) {
					console.warn(`[logs] couldn't post ${kind} log: ${err.message}`);
					if (err.code === 50013 || err.code === 50001) q.splice(0, batch.length); // no access: drop, don't loop
					break;
				}
			}
		}
	} finally {
		flushing = false;
	}
}

setInterval(flush, 15_000).unref();

// is this one of the bot's log channels? (their own messages aren't re-logged)
const isLogChannel = (id) => Object.values(channelIds).includes(id);

module.exports = { setup, push, isLogChannel, channelId: (kind) => channelIds[kind] || null };
