// The PL:BR Discord bot. Intents: Guilds only (no privileged intents -
// single members are fetched by id when their roles need updating).
const { Client, GatewayIntentBits, Events, ActivityType, REST, Routes } = require('discord.js');
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

async function startBot() {
	// GuildMembers is privileged - only requested when welcome DMs are switched on
	const intents = [GatewayIntentBits.Guilds];
	if (config.welcomeDms) intents.push(GatewayIntentBits.GuildMembers);
	const client = new Client({ intents });
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
		console.log(`[welcome] welcome DMs are ${config.welcomeDms ? 'ON' : 'off (set WELCOME_DMS=true)'}`);
		if (config.welcomeTestUserId) {
			const user = await c.users.fetch(config.welcomeTestUserId).catch(() => null);
			if (user) await welcome.sendWelcome(user, guild.name);
			else console.log(`[welcome] test user ${config.welcomeTestUserId} not found`);
		}
	});

	client.on(Events.GuildMemberAdd, (member) => {
		if (!config.welcomeDms || member.guild.id !== config.discordGuildId || member.user.bot) return;
		welcome.sendWelcome(member.user, member.guild.name);
	});

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
