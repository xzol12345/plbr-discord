// Turns a detection into ONE Discord embed in the anti-cheat log channel and
// keeps it up to date: the same ongoing incident (same key) EDITS its message
// instead of posting a new one; only after FARM_REOPEN_HOURS of quiet does it
// start a fresh message. Severity only ever goes up while an incident is open.
const crypto = require('node:crypto');
const { EmbedBuilder } = require('discord.js');
const db = require('../db/pool');
const C = require('./config');
const { playerInfo } = require('./detect');

const SEV = { Low: { color: 0xfee75c, icon: '🟡', rank: 1 }, Medium: { color: 0xf0883e, icon: '🟠', rank: 2 }, High: { color: 0xed4245, icon: '🔴', rank: 3 } };
const t = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:f>`;
const tt = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:T>`;
const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US'));
const kd = (k, d) => (k == null ? '?' : (d > 0 ? k / d : k).toFixed(2));
const span = (a, b) => {
	const m = Math.max(1, Math.round((new Date(b) - new Date(a)) / 60_000));
	return m < 120 ? `${m} minute(s)` : `${(m / 60).toFixed(1)} hours`;
};

function suspectBlock(s) {
	return [
		`Username: **${s.name}**`,
		`UserId: \`${s.userId}\``,
		`Current Kills: ${fmt(s.kills)}`,
		`Current Wins: ${fmt(s.wins)}`,
		`Current Deaths: ${fmt(s.deaths)}`,
		`K/D Ratio: ${kd(s.kills, s.deaths)}`,
		`Account age: ${s.accountAge == null ? 'unknown' : `${fmt(s.accountAge)} days`}`,
		`Tracked playtime: ${s.playSeconds ? `${(s.playSeconds / 3600).toFixed(1)} h over ${s.sessions} session(s)` : 'not tracked yet'}`,
		`Profile: https://www.roblox.com/users/${s.userId}/profile`,
	].join('\n');
}

function detailBlock(inc) {
	const d = inc.data;
	if (inc.key.startsWith('pair:')) {
		return {
			name: 'Repeated Elimination Details',
			value: [
				`Victim: **${d.victim.name}**`,
				`Victim UserId: \`${d.victim.userId}\``,
				`Victim account age: ${d.victim.accountAge == null ? 'unknown' : `${d.victim.accountAge} days`} · victim's own kills: ${fmt(d.victim.kills)}`,
				`Total Eliminations: **${d.total}** (${d.total7d} in 7 days)`,
				`Time Period: ${span(d.first, d.last)} (${t(d.first)} → ${t(d.last)})`,
				`Matches Involved: ${d.matches} ${d.matches <= 1 ? '(one match)' : '(across multiple matches)'}`,
				`Matches together (7 days): ${d.shared} · their kills back: ${d.back}`,
			].join('\n'),
		};
	}
	if (inc.key.startsWith('feeders:')) {
		return {
			name: 'Accounts Being Eliminated (last 24 hours)',
			value: d.victims.map((v) => `• **${v.name}** (\`${v.userId}\`) - ${v.n} times · account ${v.accountAge == null ? '?' : `${v.accountAge}d`} · own kills ${fmt(v.kills)}`).join('\n')
				+ (d.together ? `\nIn the same matches together: ${d.together} time(s)` : ''),
		};
	}
	if (inc.key.startsWith('pairing:')) {
		return {
			name: 'Repeated Pairing Details (last 24 hours)',
			value: [
				`With: **${d.partner.name}** (\`${d.partner.userId}\`) · account ${d.partner.accountAge == null ? '?' : `${d.partner.accountAge} days`}`,
				`Small matches together: ${d.shared} (avg ${d.avg.toFixed(1)} players)`,
				`Kills: ${d.ab} on them · ${d.ba} back`,
				`Wins in those matches: ${d.wins}`,
			].join('\n'),
		};
	}
	const lines = d.recent?.length ? d.recent.map((s) => `${t(s.at)} - ${fmt(s.kills)} kills · ${fmt(s.wins)} wins`) : ['(no recent stat changes recorded yet)'];
	if (d.matches?.played) lines.push(`Tracked matches: ${d.matches.played} played, ${d.matches.won} won`);
	return { name: 'Stat History', value: lines.join('\n') };
}

function buildEmbed(inc, suspect) {
	const sev = SEV[inc.severity];
	const e = new EmbedBuilder()
		.setColor(sev.color)
		.setTitle('🚨 POSSIBLE STAT FARMING DETECTED')
		.setDescription(`**${inc.kind}**\n${sev.icon} **Severity: ${inc.severity}** (score ${inc.score})`)
		.addFields(
			{ name: 'Suspected Player', value: suspectBlock(suspect) },
			detailBlock(inc),
		);
	if (inc.data.times?.length) {
		const max = 40;
		const lines = inc.data.times.slice(0, max).map((d) => `${t(d)}`);
		const more = inc.data.times.length > max ? `\n…and ${inc.data.times.length - max} more` : '';
		// split across fields (Discord: 1024 characters each)
		let chunk = [];
		let part = 1;
		for (const l of lines) {
			if ((chunk.join('\n') + l).length > 950) {
				e.addFields({ name: part === 1 ? 'Elimination Timestamps' : 'Elimination Timestamps (cont.)', value: chunk.join('\n') });
				chunk = [];
				part += 1;
			}
			chunk.push(l);
		}
		if (chunk.length) e.addFields({ name: part === 1 ? 'Elimination Timestamps' : 'Elimination Timestamps (cont.)', value: chunk.join('\n') + more });
	}
	e.addFields(
		{ name: 'Detection Reasons', value: inc.indicators.map((i) => `• ${i.reason}`).join('\n').slice(0, 1024) },
		{ name: 'Detection Status', value: '**Needs Staff Review** - this is an indication of suspicious activity, NOT proof of cheating. Nothing was done to the player in game.' },
	);
	e.setFooter({ text: `PL:BR Anti-Cheat · Stat Farming Detection · ${inc.key}` }).setTimestamp();
	return e;
}

// what makes an update worth an edit (not every scan)
function fingerprint(inc) {
	const d = inc.data;
	const core = { s: inc.severity, r: inc.indicators.map((i) => i.reason), t: d.total, v: d.victims?.map((v) => [v.userId, v.n]), sh: d.shared };
	return crypto.createHash('sha1').update(JSON.stringify(core)).digest('hex');
}

// -> { action: 'new' | 'edit' | 'none', row }
async function upsert(inc, now = Date.now()) {
	const fp = fingerprint(inc);
	const old = (await db.query('SELECT * FROM farm_incidents WHERE key = $1', [inc.key])).rows[0];
	const reopen = !old || now - new Date(old.last_at).getTime() > C.reopenAfterHours * 3600 * 1000;
	if (!reopen && old.details?.fp === fp) return { action: 'none', row: old };
	// severity never drops while the incident is open
	if (!reopen && SEV[old.severity].rank > SEV[inc.severity].rank) {
		inc.severity = old.severity;
	}
	const details = { fp, indicators: inc.indicators };
	const r = await db.query(
		`INSERT INTO farm_incidents (key, kind, user_id, severity, score, summary, details, first_at, last_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
		 ON CONFLICT (key) DO UPDATE SET severity = EXCLUDED.severity, score = EXCLUDED.score, summary = EXCLUDED.summary,
		   details = EXCLUDED.details, last_at = EXCLUDED.last_at,
		   first_at = CASE WHEN $9 THEN EXCLUDED.first_at ELSE farm_incidents.first_at END,
		   message_id = CASE WHEN $9 THEN NULL ELSE farm_incidents.message_id END
		 RETURNING *`,
		[inc.key, inc.kind, inc.userId, inc.severity, inc.score, inc.indicators.map((i) => i.reason).join(' | ').slice(0, 1000), details, new Date(now), reopen],
	);
	return { action: reopen || !old.message_id ? 'new' : 'edit', row: r.rows[0] };
}

// posts / edits the Discord message. channel: a text channel (or null = only stored)
async function publish(channel, inc, now = Date.now()) {
	const { action, row } = await upsert(inc, now);
	if (action === 'none' || !channel) return action;
	const embed = buildEmbed(inc, await playerInfo(inc.userId));
	const payload = { embeds: [embed], allowedMentions: { parse: [] } };
	if (action === 'edit' && row.message_id) {
		const msg = await channel.messages.fetch(row.message_id).catch(() => null);
		if (msg) {
			try {
				await msg.edit(payload);
			} catch (err) {
				await db.query(`UPDATE farm_incidents SET details = details - 'fp' WHERE key = $1`, [inc.key]);
				throw err;
			}
			return 'edit';
		}
	}
	try {
		const sent = await channel.send(payload);
		await db.query('UPDATE farm_incidents SET message_id = $2, channel_id = $3 WHERE key = $1', [inc.key, sent.id, channel.id]);
		return 'new';
	} catch (err) {
		// Discord unreachable: forget the fingerprint so the next scan posts it again
		await db.query(`UPDATE farm_incidents SET details = details - 'fp' WHERE key = $1`, [inc.key]);
		throw err;
	}
}

module.exports = { buildEmbed, upsert, publish, fingerprint };
