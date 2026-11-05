// Entry point: runs the API (for Roblox game servers) and the Discord bot
// in one Railway service. They only share the database and an event bus.
const config = require('./config');
const db = require('./db/pool');
const { createApp } = require('./api/server');

async function main() {
	await db.migrate();
	const app = createApp();
	const server = app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));

	let client = null;
	if (config.botEnabled) {
		const { startBot } = require('./bot');
		client = await startBot();
	} else {
		console.warn('[bot] DISCORD_TOKEN / DISCORD_GUILD_ID not set - running the API only');
	}
	if (!config.robloxSyncKeys.length) console.warn('[api] ROBLOX_SYNC_KEYS not set - the game cannot sync yet');

	const shutdown = async (signal) => {
		console.log(`[main] ${signal} - shutting down`);
		server.close();
		if (client) client.destroy();
		await db.close().catch(() => {});
		process.exit(0);
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection', err));

main().catch((err) => {
	console.error('[main] failed to start', err);
	process.exit(1); // Railway restarts the service
});
