// Role logic against a fake Discord guild (no network).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';
const roles = require('../src/bot/roles');
const { KILL_TIERS, WIN_TIERS } = require('../src/stats/tiers');

function fakeGuild({ botPosition = 100, existing = [] } = {}) {
	let nextId = 1;
	const all = new Map();
	const add = (name, position) => {
		const r = { id: `r${nextId++}`, name, position };
		all.set(r.id, r);
		return r;
	};
	for (const name of existing) add(name, 5);
	add('Moderator', 50);
	const botRole = add('PL:BR Bot', botPosition);
	const member = { roles: { cache: new Map() } };
	member.roles.add = async (ids) => ids.forEach((id) => member.roles.cache.set(id, all.get(id)));
	member.roles.remove = async (ids) => ids.forEach((id) => member.roles.cache.delete(id));
	const guild = {
		roles: {
			cache: all,
			fetch: async () => ({ find: (fn) => [...all.values()].find(fn) }),
			create: async ({ name }) => add(name, 10),
		},
		members: {
			me: { permissions: { has: () => true }, roles: { highest: botRole } },
			fetch: async () => member,
		},
	};
	return { guild, member, all };
}

const names = (member) => [...member.roles.cache.values()].map((r) => r.name).sort();

test('creates missing roles once and reuses existing ones', async () => {
	const { guild, all } = fakeGuild({ existing: ['Recruit', 'Champion'] });
	await roles.ensureRoles(guild);
	const count = [...all.values()].filter((r) => r.name === 'Recruit').length;
	assert.equal(count, 1);
	for (const t of [...KILL_TIERS, ...WIN_TIERS]) assert.ok([...all.values()].some((r) => r.name === t.name), t.name);
	await roles.ensureRoles(guild); // second run: no duplicates
	assert.equal([...all.values()].filter((r) => r.name === 'Fighter').length, 1);
});

test('one role per progression; promotions remove the old tier only', async () => {
	const { guild, member } = fakeGuild();
	await roles.ensureRoles(guild);
	const mod = [...guild.roles.cache.values()].find((r) => r.name === 'Moderator');
	member.roles.cache.set(mod.id, mod); // an unrelated role must survive
	await roles.syncMember(guild, 'd1', { kills: 50, wins: 3 });
	assert.deepEqual(names(member), ['Moderator', 'Recruit']);
	await roles.syncMember(guild, 'd1', { kills: 1200, wins: 120 });
	assert.deepEqual(names(member), ['Assassin', 'Elite Champion', 'Moderator']);
	await roles.syncMember(guild, 'd1', { kills: 1300, wins: 260 }); // wins up, kills same tier
	assert.deepEqual(names(member), ['Assassin', 'Moderator', 'Unstoppable']);
	await roles.syncMember(guild, 'd1', { kills: 10000, wins: 500 });
	assert.deepEqual(names(member), ['Moderator', 'PL:BR Legend', 'Untouchable']);
});

test('never assigns roles above the bot', async () => {
	const { guild, member } = fakeGuild({ botPosition: 8 }); // created roles sit at 10 > 8
	await roles.ensureRoles(guild);
	const r = await roles.syncMember(guild, 'd2', { kills: 500, wins: 0 });
	assert.equal(member.roles.cache.size, 0);
	assert.deepEqual(r.blocked, ['Mercenary']);
});

test('all bot modules load', () => {
	require('../src/bot/commands');
	require('../src/bot/leaderboards');
	require('../src/bot/index');
	const { definitions } = require('../src/bot/commands');
	assert.deepEqual(definitions.map((d) => d.name).sort(), ['leaderboard', 'leaderboard-refresh', 'link', 'nuke', 'rank', 'refresh', 'stats']);
});

test('/nuke refuses channels it must not touch', () => {
	const { ChannelType, PermissionFlagsBits } = require('discord.js');
	const { blockedReason } = require('../src/bot/nuke');
	const me = {};
	const guild = { rulesChannelId: 'rules', publicUpdatesChannelId: 'upd', members: { me } };
	const ch = (id, type = ChannelType.GuildText, canManage = true) => ({
		id, type, deletable: canManage,
		permissionsFor: () => ({ has: (p) => p !== PermissionFlagsBits.ManageChannels || canManage }),
	});
	assert.equal(blockedReason(ch('general'), guild), null);
	assert.match(blockedReason(ch('rules'), guild), /Rules/);
	assert.match(blockedReason(ch('upd'), guild), /Community Updates/);
	assert.match(blockedReason(ch('t', ChannelType.PublicThread), guild), /Only text/);
	assert.match(blockedReason(ch('general', ChannelType.GuildText, false), guild), /Manage Channels/);
	assert.match(blockedReason(null, guild), /Only text/);
});

test('welcome DM mentions Bloxlink verification first', () => {
	const { welcomeMessage } = require('../src/bot/welcome');
	const text = welcomeMessage('PL:BR').embeds[0].toJSON().description;
	assert.match(text, /Verify with Bloxlink first/);
	assert.ok(text.indexOf('/verify') < text.indexOf('/refresh'));
	assert.ok(text.length < 4096);
});
