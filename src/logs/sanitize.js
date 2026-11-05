// Game -> Discord log embeds. The game is trusted (it holds the sync key),
// but every embed is still rebuilt from known fields and clipped to Discord's
// limits, so a bad payload can't break a message.
const CHANNELS = new Set(['anticheat', 'panel']);

const clip = (v, n) => {
	const s = String(v ?? '').trim();
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function sanitizeEmbed(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const e = {};
	if (raw.title) e.title = clip(raw.title, 256);
	if (raw.description) e.description = clip(raw.description, 4000);
	if (Number.isInteger(raw.color) && raw.color >= 0 && raw.color <= 0xffffff) e.color = raw.color;
	if (typeof raw.timestamp === 'string' && !Number.isNaN(Date.parse(raw.timestamp))) e.timestamp = new Date(raw.timestamp).toISOString();
	if (raw.footer && raw.footer.text) e.footer = { text: clip(raw.footer.text, 200) };
	if (Array.isArray(raw.fields)) {
		e.fields = raw.fields.slice(0, 25)
			.filter((f) => f && f.name && f.value)
			.map((f) => ({ name: clip(f.name, 256), value: clip(f.value, 1024), inline: f.inline === true }));
	}
	if (!e.title && !e.description && !e.fields?.length) return null;
	// total size cap (Discord: 6000 per embed) - trim fields from the end
	const size = () => JSON.stringify(e).length;
	while (size() > 5800 && e.fields?.length) e.fields.pop();
	if (size() > 5800 && e.description) e.description = clip(e.description, 1500);
	return e;
}

function validateLog(raw) {
	if (!raw || !CHANNELS.has(raw.channel)) return null;
	const embed = sanitizeEmbed(raw.embed);
	return embed ? { channel: raw.channel, embed } : null;
}

module.exports = { validateLog, sanitizeEmbed, CHANNELS };
