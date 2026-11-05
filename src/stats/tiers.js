// Discord role progressions. Each list is checked independently: a player
// holds AT MOST one role from each list - the highest tier they qualify for.
// Edit names / thresholds here (the bot creates missing roles on startup).

const KILL_TIERS = [
	{ name: 'Recruit', min: 0, color: 0x9ca2ac },
	{ name: 'Fighter', min: 100, color: 0x62d892 },
	{ name: 'Mercenary', min: 500, color: 0x46a6ff },
	{ name: 'Assassin', min: 1000, color: 0xa970ff },
	{ name: 'Executioner', min: 2500, color: 0xff5252 },
	{ name: 'Legend', min: 5000, color: 0xffc43a },
	{ name: 'Untouchable', min: 10000, color: 0xee4826 },
];

const WIN_TIERS = [
	{ name: 'Survivor', min: 10, color: 0x7fd6c2 },
	{ name: 'Champion', min: 50, color: 0x4fc3f7 },
	{ name: 'Elite Champion', min: 100, color: 0x7e57c2 },
	{ name: 'Unstoppable', min: 250, color: 0xff7043 },
	{ name: 'PL:BR Legend', min: 500, color: 0xffd54f },
];

// Highest tier whose minimum is met (null if none - e.g. under 10 wins).
function tierFor(tiers, value) {
	let best = null;
	for (const t of tiers) if (value >= t.min) best = t;
	return best;
}

function nextTier(tiers, value) {
	return tiers.find((t) => t.min > value) || null;
}

module.exports = { KILL_TIERS, WIN_TIERS, tierFor, nextTier };
