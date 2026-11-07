const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';
const filter = require('../src/moderation/filter');
const { SpamTracker } = require('../src/moderation/spam');

test('invite links are blocked, normal "gg" talk is not', () => {
	for (const s of ['discord.gg/abc', 'join https://discord.gg/xyz', 'discord . gg / abc', 'dsc.gg/abc', 'x.gg/y', 'discord.com/invite/abcd', 'discordapp.com/invite/q', 'discord.me/server']) {
		assert.equal(filter.check(s)?.reason, 'Discord invite link', s);
	}
	for (const s of ['gg', 'gg ez', 'good.gg game', 'gg/ez', 'see you.gg']) assert.equal(filter.check(s), null, s);
});

test('slurs are blocked, also disguised; normal words are not', () => {
	for (const s of ['nigger', 'N1GG3R', 'n i g g e r', 'n.i.g.g.e.r', 'niiiigger', 'nigga', 'faggot', 'f@gg0t', 'f a g g o t', 'fag', 'jew', 'Jews', 'kike', 'retard', 'coon', 'ch1nk']) {
		assert.equal(filter.check(s)?.reason, 'Offensive language', s);
	}
	for (const s of ['Nigeria trip', 'the Niger river', 'snigger', 'I love my jewelry', 'jewels', 'Jewish holiday', 'fagioli', 'raccoon', 'spicy', 'glass', 'chinkapin oak', 'hello there', 'good game']) {
		assert.equal(filter.check(s), null, s);
	}
});

test('anti-spam: the same message 3 times deletes all recent messages', () => {
	const t = new SpamTracker({ repeats: 3, windowMs: 60_000 });
	const k = (c) => filter.spamKey(c);
	assert.equal(t.add('u', { id: '1', channelId: 'a', key: k('hello'), at: 0 }), null);
	assert.equal(t.add('u', { id: '2', channelId: 'a', key: k('other'), at: 1000 }), null);
	assert.equal(t.add('u', { id: '3', channelId: 'b', key: k('HELLO '), at: 2000 }), null);
	const del = t.add('u', { id: '4', channelId: 'a', key: k('hello'), at: 3000 });
	assert.deepEqual(del.map((m) => m.id), ['1', '2', '3', '4']); // every message in the window, all channels
	// another member is separate; old messages fall out of the window
	assert.equal(t.add('v', { id: '5', channelId: 'a', key: k('hello'), at: 4000 }), null);
	const t2 = new SpamTracker({ repeats: 3, windowMs: 60_000 });
	t2.add('u', { id: '1', channelId: 'a', key: 'x', at: 0 });
	t2.add('u', { id: '2', channelId: 'a', key: 'x', at: 1000 });
	assert.equal(t2.add('u', { id: '3', channelId: 'a', key: 'x', at: 120_000 }), null);
});
