// Welcome DM for new members. Needs the privileged "Server Members Intent"
// (Developer Portal -> Bot), so it's only switched on when WELCOME_DMS=true.
// A member with DMs closed simply doesn't get it - that's logged, not an error.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const embeds = require('./embeds');
const { KILL_TIERS } = require('../stats/tiers');

function welcomeMessage(guildName) {
	const roles = KILL_TIERS.map((t) => `• **${t.name}**`).join('\n');
	const e = embeds.infoEmbed(`👋 Welcome to ${guildName}!`, [
		'Glad to have you here! To get your **PL:BR stats** and **kill roles** in the server, link your Roblox account first:',
		'',
		'**1. Verify with Bloxlink first** ✅',
		'Run **`/verify`** in the server (Bloxlink\'s command). Sign in with Discord and pick the Roblox account you play PL:BR on.',
		'',
		'**2. Then verify with PL:BR**',
		'After Bloxlink, run **`/link`** in the server. That connects your account to PL:BR and gives you your kill role.',
		'',
		'**Kill roles you can earn:**',
		roles,
		'',
		'Your stats come from the game itself, so **play a match** if they don\'t show up yet. See you on the battlefield! 💀',
	].join('\n'));
	const components = config.gameUrl
		? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Play PL:BR').setURL(config.gameUrl))]
		: [];
	return { embeds: [e], components };
}

async function sendWelcome(user, guildName) {
	try {
		await user.send(welcomeMessage(guildName));
		console.log(`[welcome] DM sent to ${user.tag} (${user.id})`);
		return true;
	} catch (err) {
		console.log(`[welcome] couldn't DM ${user.tag} (${user.id}) - DMs are probably closed (${err.message})`);
		return false;
	}
}

module.exports = { welcomeMessage, sendWelcome };
