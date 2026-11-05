// Discord role progressions. Each list is checked independently: a player
// holds AT MOST one role from each list - the highest tier they qualify for.
// Defaults below; the server's OWN roles can be used instead via env vars:
//   KILL_ROLES="0=Recruit;100=Fighter;500=Some Role"   (min kills = exact role name)
//   WIN_ROLES="none"                                    (no win roles at all)
// Roles listed in an env var must already exist in the server - the bot only
// creates the built-in defaults, never roles from these variables.

const DEFAULT_KILL_TIERS = [
	{ name: 'Recruit', min: 0, color: 0x9ca2ac },
	{ name: 'Fighter', min: 100, color: 0x62d892 },
	{ name: 'Mercenary', min: 500, color: 0x46a6ff },
	{ name: 'Assassin', min: 1000, color: 0xa970ff },
	{ name: 'Executioner', min: 2500, color: 0xff5252 },
	{ name: 'Legend', min: 5000, color: 0xffc43a },
	{ name: 'Untouchable', min: 10000, color: 0xee4826 },
];

const DEFAULT_WIN_TIERS = [
	{ name: 'Survivor', min: 10, color: 0x7fd6c2 },
	{ name: 'Champion', min: 50, color: 0x4fc3f7 },
	{ name: 'Elite Champion', min: 100, color: 0x7e57c2 },
	{ name: 'Unstoppable', min: 250, color: 0xff7043 },
	{ name: 'PL:BR Legend', min: 500, color: 0xffd54f },
];

// Parses "0=Name;100=Other Name". Returns null when unset, [] for "none".
function parseTiers(raw, label) {
	if (raw == null || raw.trim() === '') return null;
	if (raw.trim().toLowerCase() === 'none') return [];
	const tiers = raw.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
		const eq = part.indexOf('=');
		const min = Number(part.slice(0, eq).trim());
		const name = part.slice(eq + 1).trim();
		if (eq < 1 || !Number.isSafeInteger(min) || min < 0 || !name) throw new Error(`${label}: bad entry "${part}" (use min=Role Name)`);
		return { name, min, custom: true };
	});
	tiers.sort((a, b) => a.min - b.min);
	if (new Set(tiers.map((t) => t.min)).size !== tiers.length) throw new Error(`${label}: two roles share the same minimum`);
	return tiers;
}

const KILL_TIERS = parseTiers(process.env.KILL_ROLES, 'KILL_ROLES') ?? DEFAULT_KILL_TIERS;
const WIN_TIERS = parseTiers(process.env.WIN_ROLES, 'WIN_ROLES') ?? DEFAULT_WIN_TIERS;

// Highest tier whose minimum is met (null if none - e.g. under 10 wins).
function tierFor(tiers, value) {
	let best = null;
	for (const t of tiers) if (value >= t.min) best = t;
	return best;
}

function nextTier(tiers, value) {
	return tiers.find((t) => t.min > value) || null;
}

module.exports = { KILL_TIERS, WIN_TIERS, DEFAULT_KILL_TIERS, DEFAULT_WIN_TIERS, parseTiers, tierFor, nextTier };
