// Reads every setting from environment variables (Railway "Variables").
// Nothing secret is ever hardcoded here - see .env.example for the list.

function str(name, fallback) {
	const v = process.env[name];
	return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback) {
	const v = Number.parseInt(process.env[name] ?? '', 10);
	return Number.isFinite(v) ? v : fallback;
}

function list(name) {
	return (str(name, '') || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
	env: str('NODE_ENV', 'development'),
	port: int('PORT', 3000),

	// Postgres (Railway provides DATABASE_URL from its Postgres service)
	databaseUrl: str('DATABASE_URL'),
	databaseSsl: str('DATABASE_SSL', 'auto'), // auto | true | false

	// Roblox game servers -> API (shared secret, stored as a Roblox Secret too)
	robloxSyncKeys: list('ROBLOX_SYNC_KEYS'), // comma-separated: lets you rotate keys without downtime

	// Discord
	discordToken: str('DISCORD_TOKEN'),
	discordClientId: str('DISCORD_CLIENT_ID'),
	discordGuildId: str('DISCORD_GUILD_ID'),
	killLeaderboardChannelId: str('KILL_LEADERBOARD_CHANNEL_ID'),
	winLeaderboardChannelId: str('WIN_LEADERBOARD_CHANNEL_ID'),
	leaderboardIntervalMinutes: int('LEADERBOARD_INTERVAL_MINUTES', 10),
	roleReconcileMinutes: int('ROLE_RECONCILE_MINUTES', 30),

	// Bloxlink (server API key from the Bloxlink dashboard)
	bloxlinkApiKey: str('BLOXLINK_API_KEY'),

	// Roblox Open Cloud (optional - read-only backfill / reconciliation)
	robloxUniverseId: str('ROBLOX_UNIVERSE_ID'),
	robloxOpenCloudKey: str('ROBLOX_OPEN_CLOUD_KEY'),
	statsDataStore: str('ROBLOX_STATS_DATASTORE'),
	statsDataStoreScope: str('ROBLOX_STATS_DATASTORE_SCOPE', 'global'),
	statsEntryKeyFormat: str('ROBLOX_STATS_ENTRY_KEY', '{userId}'),
	// where kills / wins / deaths live inside the saved entry, e.g. "kills=Kills,wins=Wins,deaths=Deaths"
	statsFields: Object.fromEntries(list('ROBLOX_STATS_FIELDS').map((p) => p.split('=').map((s) => s.trim()))),
	killsOrderedDataStore: str('ROBLOX_KILLS_ORDERED_DATASTORE'),
	winsOrderedDataStore: str('ROBLOX_WINS_ORDERED_DATASTORE'),
	orderedDataStoreScope: str('ROBLOX_ORDERED_DATASTORE_SCOPE', 'global'),

	// Branding
	brandColor: Number.parseInt(str('BRAND_COLOR', 'EE4826'), 16), // PL:BR red-orange
	brandName: str('BRAND_NAME', 'PL:BR'),
	gameUrl: str('GAME_URL', ''),
};

config.openCloudEnabled = Boolean(config.robloxUniverseId && config.robloxOpenCloudKey);
config.botEnabled = Boolean(config.discordToken && config.discordGuildId);

module.exports = config;
