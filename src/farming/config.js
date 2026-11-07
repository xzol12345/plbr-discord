// Stat farming / alt farming detection thresholds. Every value can be
// overridden with an environment variable (Railway -> Variables) of the
// same name, e.g. FARM_REPEAT_MEDIUM=20. Detection ONLY: nothing here ever
// touches a player in game.
function n(name, fallback) {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

module.exports = {
	retentionDays: n('FARM_RETENTION_DAYS', 30),
	scanEveryMinutes: n('FARM_SCAN_MINUTES', 3),
	reopenAfterHours: n('FARM_REOPEN_HOURS', 24), // a quiet incident this old starts a NEW log message

	// 1) same killer -> same victim
	repeat: {
		windowMinutes: n('FARM_REPEAT_WINDOW_MINUTES', 60),
		low: n('FARM_REPEAT_LOW', 10),       // kills of one victim within the window
		medium: n('FARM_REPEAT_MEDIUM', 15),
		high: n('FARM_REPEAT_HIGH', 25),
		dayLow: n('FARM_REPEAT_DAY_LOW', 30), // ...or within 24 h
	},
	// B) one-sided pair: they meet a lot, one always wins
	oneSided: {
		minSharedMatches: n('FARM_ONESIDED_MATCHES', 8),
		minKills: n('FARM_ONESIDED_KILLS', 8),
		maxReturnRatio: 0.1, // victim's kills back / killer's kills
	},
	// C) several accounts feeding one player (within 24 h)
	feeders: {
		minVictims: n('FARM_FEEDERS_VICTIMS', 3),
		killsEach: n('FARM_FEEDERS_KILLS_EACH', 5),
	},
	// A/E) the same accounts keep ending up in the same (small) matches (24 h)
	pairing: {
		minSharedMatches: n('FARM_PAIRING_MATCHES', 12),
		smallMatchPlayers: n('FARM_SMALL_MATCH_PLAYERS', 4), // a match this size or smaller counts as "small"
	},
	// young accounts (days) - feeding alts are usually brand new
	youngAccountDays: n('FARM_YOUNG_ACCOUNT_DAYS', 30),
	// 2) stat ratios (all-time saved totals)
	ratio: {
		minWins: n('FARM_RATIO_MIN_WINS', 30),
		maxKillsPerWin: n('FARM_RATIO_MAX_KILLS_PER_WIN', 0.5), // e.g. 4 kills / 60 wins
		jumpHours: n('FARM_JUMP_HOURS', 1),
		jumpKills: n('FARM_JUMP_KILLS', 120),
		jumpWins: n('FARM_JUMP_WINS', 20),
		killsPerHour: n('FARM_KILLS_PER_HOUR', 80), // over tracked playtime
		minPlayHours: n('FARM_MIN_PLAY_HOURS', 1),
		winRate: 0.8, minMatches: n('FARM_WINRATE_MIN_MATCHES', 15),
	},
	// scoring: points add up across indicators; below `low` nothing is logged
	severity: { low: 3, medium: 5, high: 8 },
};
