// The PL:BR Discord bot. Intents: Guilds, plus Server Members (privileged)
// ONLY when it's switched on in the Developer Portal - checked at startup
// from the application's flags, so the bot never fails to log in over it.
// It powers welcome DMs and instant Server Booster detection; everything
// else works without it (single members are fetched by id).
const { Client, GatewayIntentBits, Events, ActivityType, REST, Routes, Partials } = require('discord.js');
const config = require('../config');
const events = require('../events');
const commands = require('./commands');
const roles = require('./roles');
const linking = require('./linking');
const leaderboards = require('./leaderboards');
const reconcile = require('../sync/reconcile');
const store = require('../stats/store');
const bloxlink = require('../services/bloxlink');
const welcome = require('./welcome');
const logChannels = require('./logChannels');
const { resultLog } = require('./ban');
const boost = require('./boost');
const automod = require('./automod');
const serverLogs = require('./serverLogs');
const farming = require('../farming/scanner');

async function registerCommands() {
	const rest = new REST({ version: '10' }).setToken(config.discordToken);
	await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body: commands.definitions });
	console.log(`[bot] registered ${commands.definitions.length} slash commands`);
}

// role updates are queued per member so bursts of kills don't spam Discord
function createRoleQueue(getGuild) {
	const pending = new Map(); // discordId -> player
	let running = false;
	async function drain() {
		if (running) return;
		running = true;
		while (pending.size) {
			const [discordId, player] = pending.entries().next().value;
			pending.delete(discordId);
			try {
				const guild = getGuild();
				if (guild) await roles.syncMember(guild, discordId, player);
			} catch (err) {
				console.warn(`[roles] sync ${discordId}: ${err.message}`);
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		running = false;
	}
	return (discordId, player) => {
		pending.set(discordId, player);
		setTimeout(drain, 1500); // small debounce
	};
}

const reverseLookupMiss = new Map(); // robloxId -> time (avoid hammering Bloxlink)

// Which privileged intents are switched on for this application?
// (application flags: 1<<14 / 1<<15 Server Members, 1<<18 / 1<<19 Message Content)
async function privilegedIntents() {
	try {
		const rest = new REST({ version: '10' }).setToken(config.discordToken);
		const app = await rest.get(Routes.currentApplication());
		const f = app.flags ?? 0;
		return { members: Boolean(f & ((1 << 14) | (1 << 15))), content: Boolean(f & ((1 << 18) | (1 << 19))) };
	} catch (err) {
		console.warn('[bot] couldn\'t read the application flags - starting without privileged intents', err.message);
		return { members: false, content: false };
	}
}

async function startBot() {
	const privileged = await privilegedIntents();
	const membersIntent = privileged.members;
	const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates];
	if (membersIntent) intents.push(GatewayIntentBits.GuildMembers);
	if (privileged.content) intents.push(GatewayIntentBits.MessageContent);
	const client = new Client({
		intents,
		partials: [Partials.Message, Partials.Channel], // deletes / edits of messages from before a restart still arrive
	});
	let guild = null;
	const queueRoles = createRoleQueue(() => guild);

	client.once(Events.ClientReady, async (c) => {
		console.log(`[bot] online as ${c.user.tag}`);
		c.user.setActivity('PL:BR', { type: ActivityType.Competing });
		guild = await c.guilds.fetch(config.discordGuildId).catch(() => null);
		if (!guild) {
			console.error('[bot] the bot is not in DISCORD_GUILD_ID - invite it first');
			return;
		}
		await guild.members.fetchMe();
		await roles.ensureRoles(guild);
		await registerCommands().catch((err) => console.error('[bot] command registration failed', err.message));
		await leaderboards.update(client, { force: true });
		await logChannels.setup(c, guild).catch((err) => console.error('[logs] setup failed', err.message));
		console.log(`[bot] Server Members Intent is ${membersIntent ? 'ON' : 'off (Developer Portal -> Bot)'}`);
		console.log(`[bot] Message Content Intent is ${privileged.content ? 'ON - auto-moderation, anti-spam and message logs are active' : 'off (Developer Portal -> Bot) - auto-moderation, anti-spam and message logs can\'t read messages'}`);
		const me = guild.members.me;
		for (const [perm, why] of [['ManageMessages', 'delete blocked / spam messages'], ['ViewAuditLog', 'show who server-muted / moved someone in voice logs']]) {
			if (!me.permissions.has(perm)) console.warn(`[bot] missing the ${perm} permission - needed to ${why}`);
		}
		console.log(`[welcome] welcome DMs are ${config.welcomeDms && membersIntent ? 'ON' : config.welcomeDms ? 'waiting for the Server Members Intent' : 'off (set WELCOME_DMS=true)'}`);
		if (config.boostTestUserId) {
			const user = await c.users.fetch(config.boostTestUserId).catch(() => null);
			if (user) {
				await user.send({ embeds: [boost.thankYouEmbed()] })
					.then(() => console.log(`[boost] preview thank-you DM sent to ${user.tag}`))
					.catch((err) => console.log(`[boost] couldn't send the preview DM to ${user.tag}: ${err.message}`));
			}
		}
		farming.start(async () => {
			const id = logChannels.channelId('anticheat');
			return id ? c.channels.fetch(id).catch(() => null) : null;
		});
		boost.scanExisting(guild, membersIntent).catch((err) => console.warn('[boost] scan failed', err.message));
		if (config.welcomeTestUserId) {
			const user = await c.users.fetch(config.welcomeTestUserId).catch(() => null);
			if (user) await welcome.sendWelcome(user, guild.name);
			else console.log(`[welcome] test user ${config.welcomeTestUserId} not found`);
		}
	});

	// game logs (anti-cheat kicks, panel actions) -> their channels
	events.on('gameLogs', (logs) => { for (const l of logs) logChannels.push(l.channel, l.embed); });
	// every finished Discord /ban is also logged in the Manual channel
	events.on('commandFinished', (cmd) => { if (cmd.kind === 'ban') logChannels.push('panel', resultLog(cmd)); });

	// moderation + server logs
	client.on(Events.MessageCreate, (m) => { if (privileged.content) automod.handleMessage(m).catch((err) => console.warn('[automod]', err.message)); });
	client.on(Events.MessageDelete, (m) => { try { serverLogs.onMessageDelete(m); } catch (err) { console.warn('[logs] delete', err.message); } });
	client.on(Events.MessageBulkDelete, (msgs, ch) => { try { serverLogs.onMessageBulkDelete(msgs, ch); } catch (err) { console.warn('[logs] bulk', err.message); } });
	client.on(Events.MessageUpdate, (a, b) => { try { serverLogs.onMessageUpdate(a, b); } catch (err) { console.warn('[logs] edit', err.message); } });
	client.on(Events.VoiceStateUpdate, (a, b) => { serverLogs.onVoiceState(a, b).catch((err) => console.warn('[logs] voice', err.message)); });
	client.on(Events.GuildMemberAdd, (member) => { try { serverLogs.onMemberJoin(member); } catch (err) { console.warn('[logs] join', err.message); } });

	client.on(Events.GuildMemberAdd, (member) => {
		if (!config.welcomeDms || member.guild.id !== config.discordGuildId || member.user.bot) return;
		welcome.sendWelcome(member.user, member.guild.name);
	});

	// a member started boosting (Discord sets premiumSince + the Server Booster role)
	client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
		if (newMember.guild.id !== config.discordGuildId || newMember.user.bot) return;
		if (boost.isBoosting(newMember) && !boost.isBoosting(oldMember)) {
			boost.check(newMember).catch((err) => console.warn(`[boost] ${newMember.id}: ${err.message}`));
		}
	});
	// new kills / wins arrived: scan those players shortly
	events.on('farmActivity', (ids) => farming.queue(ids));
	// the game confirmed the Boost weapons are in their inventory
	events.on('boostGranted', ({ discordId }) => boost.onGranted(client, discordId));

	client.on(Events.InteractionCreate, (i) => commands.handle(i));
	client.on(Events.Error, (err) => console.error('[bot] client error', err.message));

	// game pushed new stats -> update that player's roles
	events.on('statsChanged', async (player) => {
		try {
			let ids = await linking.discordIdsFor(player.userId);
			if (!ids.length && config.bloxlinkApiKey) {
				const miss = reverseLookupMiss.get(player.userId) || 0;
				if (Date.now() - miss > 30 * 60_000) {
					ids = await bloxlink.robloxToDiscord(player.userId).catch(() => []);
					for (const id of ids) await linking.resolve(id).catch(() => null);
					if (!ids.length) reverseLookupMiss.set(player.userId, Date.now());
				}
			}
			for (const id of ids) queueRoles(id, player);
		} catch (err) {
			console.warn('[bot] statsChanged', err.message);
		}
	});

	// leaderboards on a schedule (only edited when the top 10 changed)
	setInterval(() => leaderboards.update(client), Math.max(2, config.leaderboardIntervalMinutes) * 60_000).unref();

	// reconciliation: backfill from Open Cloud, re-check every linked member
	const reconcileAll = async () => {
		try {
			const n = await reconcile.backfillTopPlayers(15);
			if (n) console.log(`[reconcile] refreshed ${n} top players from saved data`);
			for (const { discordId, robloxId } of await linking.allLinks()) {
				const player = (await reconcile.refreshFromOpenCloud(robloxId).catch(() => null)) || (await store.getPlayer(robloxId));
				if (player) queueRoles(discordId, player);
				// Server Booster rewards for linked members (works without the members intent)
				if (guild) {
					const member = await guild.members.fetch(discordId).catch(() => null);
					if (member) await boost.check(member, { robloxId }).catch((err) => console.warn(`[boost] ${discordId}: ${err.message}`));
				}
				await new Promise((r) => setTimeout(r, 400));
			}
			await store.trimLog(14);
		} catch (err) {
			console.warn('[reconcile]', err.message);
		}
	};
	setTimeout(reconcileAll, 60_000).unref();
	setInterval(reconcileAll, Math.max(5, config.roleReconcileMinutes) * 60_000).unref();

	await client.login(config.discordToken); // discord.js reconnects on its own after drops
	return client;
}

module.exports = { startBot };
