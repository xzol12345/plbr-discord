const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const config = require('../config');

let pool;

function sslOption(url) {
	if (config.databaseSsl === 'true') return { rejectUnauthorized: false };
	if (config.databaseSsl === 'false') return false;
	// auto: Railway's private network (*.railway.internal) and localhost don't use SSL
	if (/localhost|127\.0\.0\.1|\.railway\.internal/.test(url || '')) return false;
	return { rejectUnauthorized: false };
}

function getPool() {
	if (!pool) {
		if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
		pool = new Pool({ connectionString: config.databaseUrl, ssl: sslOption(config.databaseUrl), max: 10 });
		pool.on('error', (err) => console.error('[db] idle client error', err.message));
	}
	return pool;
}

function setPool(p) {
	pool = p;
}

async function query(text, params) {
	return getPool().query(text, params);
}

// Runs every .sql file in migrations/ once, in name order.
async function migrate() {
	const dir = path.join(__dirname, 'migrations');
	await query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
	const done = new Set((await query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
	for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
		if (done.has(file)) continue;
		const sql = fs.readFileSync(path.join(dir, file), 'utf8');
		const client = await getPool().connect();
		try {
			await client.query('BEGIN');
			await client.query(sql);
			await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
			await client.query('COMMIT');
			console.log(`[db] applied migration ${file}`);
		} catch (err) {
			await client.query('ROLLBACK');
			throw err;
		} finally {
			client.release();
		}
	}
}

async function close() {
	if (pool) await pool.end();
	pool = undefined;
}

module.exports = { query, migrate, getPool, setPool, close };
