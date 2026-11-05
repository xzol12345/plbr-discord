// Kill / win progression roles. Each progression is handled on its own:
// a member ends up with exactly the one role they've earned from each list
// (or none from the win list under 10 wins); roles from the OTHER list and
// any non-PL:BR roles are never touched.
const { PermissionFlagsBits } = require('discord.js');
const { KILL_TIERS, WIN_TIERS, tierFor } = require('../stats/tiers');

let roleIds = { kills: new Map(), wins: new Map() }; // tier name -> role id

// Finds (or creates, if missing) every progression role by name. Never
// creates a duplicate: an existing role with the same name is reused.
async function ensureRoles(guild) {
	const me = guild.members.me;
	if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
		console.warn('[roles] the bot is missing the Manage Roles permission - roles cannot be assigned');
	}
	const roles = await guild.roles.fetch();
	const ids = { kills: new Map(), wins: new Map() };
	for (const [kind, tiers] of [['kills', KILL_TIERS], ['wins', WIN_TIERS]]) {
		for (const tier of tiers) {
			let role = roles.find((r) => r.name === tier.name);
			if (!role && me.permissions.has(PermissionFlagsBits.ManageRoles)) {
				role = await guild.roles.create({ name: tier.name, color: tier.color, permissions: [], hoist: false, mentionable: false, reason: 'PL:BR progression role' });
				console.log(`[roles] created role ${tier.name}`);
			}
			if (role) {
				ids[kind].set(tier.name, role.id);
				if (role.position >= me.roles.highest.position) {
					console.warn(`[roles] "${role.name}" is ABOVE or level with the bot's highest role - drag the bot's role above it in Server Settings > Roles`);
				}
			}
		}
	}
	roleIds = ids;
	return ids;
}

function wanted(player) {
	const k = tierFor(KILL_TIERS, player.kills);
	const w = tierFor(WIN_TIERS, player.wins);
	return {
		kills: k ? roleIds.kills.get(k.name) : null,
		wins: w ? roleIds.wins.get(w.name) : null,
		killTier: k,
		winTier: w,
	};
}

// Brings one member's progression roles in line with their stats.
// Returns { added: [names], removed: [names] }.
async function syncMember(guild, discordId, player) {
	let member;
	try {
		member = await guild.members.fetch(discordId);
	} catch {
		return { added: [], removed: [], missing: true }; // not in the server
	}
	const want = wanted(player);
	const add = [];
	const remove = [];
	for (const kind of ['kills', 'wins']) {
		const keep = want[kind];
		for (const id of roleIds[kind].values()) {
			const has = member.roles.cache.has(id);
			if (id === keep && !has) add.push(id);
			if (id !== keep && has) remove.push(id);
		}
	}
	const me = guild.members.me;
	const manageable = (id) => {
		const r = guild.roles.cache.get(id);
		return r && r.position < me.roles.highest.position;
	};
	const addOk = add.filter(manageable);
	const removeOk = remove.filter(manageable);
	if (removeOk.length) await member.roles.remove(removeOk, 'PL:BR progression update');
	if (addOk.length) await member.roles.add(addOk, 'PL:BR progression update');
	const name = (id) => guild.roles.cache.get(id)?.name || id;
	return { added: addOk.map(name), removed: removeOk.map(name), blocked: [...add, ...remove].filter((id) => !manageable(id)).map(name) };
}

// Removes all progression roles (member un-verified with Bloxlink).
async function clearMember(guild, discordId) {
	let member;
	try { member = await guild.members.fetch(discordId); } catch { return; }
	const all = [...roleIds.kills.values(), ...roleIds.wins.values()].filter((id) => member.roles.cache.has(id));
	if (all.length) await member.roles.remove(all, 'PL:BR: no verified Roblox account');
}

module.exports = { ensureRoles, syncMember, clearMember, wanted };
