// Anti-spam memory: each member's recent messages. When the SAME message
// (spamKey) has been sent `repeats` times within `windowMs`, it reports every
// message of theirs it remembers in that window (all channels) to delete.
class SpamTracker {
	constructor({ repeats = 3, windowMs = 60_000, keep = 30 } = {}) {
		this.repeats = repeats;
		this.windowMs = windowMs;
		this.keep = keep;
		this.byUser = new Map(); // userId -> [{ id, channelId, key, at }]
	}

	// returns null, or the list of { id, channelId } to delete
	add(userId, { id, channelId, key, at = Date.now() }) {
		const list = (this.byUser.get(userId) || []).filter((m) => at - m.at <= this.windowMs);
		list.push({ id, channelId, key, at });
		while (list.length > this.keep) list.shift();
		this.byUser.set(userId, list);
		if (!key) return null;
		const same = list.filter((m) => m.key === key).length;
		if (same < this.repeats) return null;
		this.byUser.set(userId, []); // reported once; start over
		return list.map(({ id: mid, channelId: cid }) => ({ id: mid, channelId: cid }));
	}

	sweep(now = Date.now()) {
		for (const [u, list] of this.byUser) {
			const fresh = list.filter((m) => now - m.at <= this.windowMs);
			if (fresh.length) this.byUser.set(u, fresh); else this.byUser.delete(u);
		}
	}
}

module.exports = { SpamTracker };
