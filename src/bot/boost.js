// Server Booster rewards - the Discord side.
//   * who is boosting: Discord's own boost status (member.premiumSince / the
//     Server Booster role Discord manages) - never claimed by the user
//   * a new booster gets ONE thank-you DM (a closed DM is recorded, the
//     reward still goes through)
//   * the reward (Boost FAL + Boost AA-12) is recorded for their linked Roblox
//     UserId; the GAME grants it the next time that account is online and
//     confirms (rewards/boost.js + /v1/roblox/rewards/*). Not linked yet ->
//     it waits until /link, /refresh or the periodic re-check finds a link.
// Boosts are seen instantly when the Server Members Intent is on (member
// updates + a scan of existing boosters at startup); without it, through
// /link, /refresh and the 30-minute re-check of every linked member.
const config = require('../config');
const embeds = require('./embeds');
const linking = require('./linking');
const rewards = require('../rewards/boost');

const RECHECK_LINK_MS = 10 * 60_000; // don't ask Bloxlink about the same unlinked booster more often
const VERIFY_CACHE_MS = 2 * 60_000;
const lastLinkCheck = new Map();
const verifyCache = new Map(); // discordId -> { at, value }
let guildRef = null;

function isBoosting(member) {
	if (!member) return false;
	if (member.premiumSinceTimestamp) return true;
	const role = member.guild?.roles?.premiumSubscriberRole;
	return Boolean(role && member.roles?.cache?.has(role.id));
}

function thankYouEmbed() {
	return embeds.infoEmbed('🎉 THANK YOU FOR BOOSTING PL:BR!', [
		'We truly appreciate your support! As a thank-you for boosting our Discord server, you\'ve unlocked exclusive rewards both inside our Discord community and in PL:BR.',
		'',
		'**💎 INSIDE THE DISCORD SERVER**',
		'You\'ve unlocked:',
		'• 📸 Picture Permissions',
		'• 🎁 Access to Exclusive Giveaways',
		'',
		'**🔫 INSIDE PL:BR**',
		'You\'ve unlocked:',
		'• 💗 Boost FAL',
		'• 💗 Boost AA-12',
		'',
		'**IMPORTANT – LINK YOUR ROBLOX ACCOUNT**',
		'To receive your exclusive in-game weapons, your Roblox account must be linked to your Discord account!',
		'',
		'1. Verify with **Bloxlink** first: run **`/verify`** in the server.',
		'2. Then run **`/link`** in the server.',
		'',
		'• Already linked? Your weapons are added to your inventory automatically the next time you\'re in PL:BR.',
		'• Not linked yet? Link any time with `/link` - your weapons are granted automatically once you\'re linked.',
		'',
		'You never have to open a ticket or ask for your rewards.',
		'',
		'**Thank you for supporting PL:BR! ❤️**',
	].join('\n')).setColor(0xff4fd8);
}

function grantedEmbed() {
	return embeds.infoEmbed('💗 Your Boost weapons are here!', 'The **Boost FAL** and **Boost AA-12** are now in your PL:BR inventory. Equip them from your inventory - thanks again for boosting!').setColor(0xff4fd8);
}

async function linkedRobloxId(discordId) {
	const stored = await linking.storedRobloxId(discordId);
	if (stored || !config.bloxlinkApiKey) return stored;
	const last = lastLinkCheck.get(discordId) || 0;
	if (Date.now() - last < RECHECK_LINK_MS) return null;
	lastLinkCheck.set(discordId, Date.now());
	return linking.resolve(discordId).catch(() => null);
}

// Call with any member; does nothing unless they're boosting. Safe to call
// any number of times (one DM ever, one reward ever). Returns a short status.
async function check(member, { robloxId } = {}) {
	if (!isBoosting(member)) return 'not-boosting';
	const discordId = member.id;
	verifyCache.set(discordId, { at: Date.now(), value: true });
	const linked = robloxId || (await linkedRobloxId(discordId));
	const { row, isNew } = await rewards.recordBooster(discordId, linked);
	if (isNew) console.log(`[boost] new booster ${member.user.tag} (${discordId})${linked ? ` - linked to Roblox ${linked}` : ' - not linked yet'}`);
	if (!row.dm_sent_at && !row.dm_failed_at) {
		try {
			await member.send({ embeds: [thankYouEmbed()] });
			await rewards.markDm(discordId, true);
			console.log(`[boost] thank-you DM sent to ${member.user.tag}`);
		} catch (err) {
			await rewards.markDm(discordId, false);
			console.log(`[boost] couldn't DM ${member.user.tag} (DMs closed?) - the reward is still recorded (${err.message})`);
		}
	}
	if (row.granted_at) return 'granted';
	return row.roblox_user_id ? 'waiting-for-game' : 'waiting-for-link';
}

// The game asks before granting: is this member STILL boosting? (cached briefly)
async function verify(discordId) {
	const c = verifyCache.get(discordId);
	if (c && Date.now() - c.at < VERIFY_CACHE_MS) return c.value;
	if (!guildRef) return null;
	let value;
	try {
		const member = await guildRef.members.fetch({ user: discordId, force: true });
		value = isBoosting(member);
	} catch (err) {
		value = err.code === 10007 ? false : null; // 10007: not in the server any more
	}
	if (value !== null) verifyCache.set(discordId, { at: Date.now(), value });
	return value;
}

// startup: every current booster (needs the Server Members Intent to list them)
async function scanExisting(guild, membersIntent) {
	guildRef = guild;
	rewards.setVerifier(verify);
	if (!membersIntent) {
		console.log('[boost] Server Members Intent is off - boosts are picked up through /link, /refresh and the 30-minute re-check (turn the intent on for instant thank-you DMs)');
		return;
	}
	const members = await guild.members.fetch().catch((err) => { console.warn('[boost] member list failed', err.message); return null; });
	if (!members) return;
	const boosters = members.filter((m) => !m.user.bot && isBoosting(m));
	console.log(`[boost] ${boosters.size} current booster(s)`);
	for (const m of boosters.values()) {
		await check(m).catch((err) => console.warn(`[boost] ${m.id}: ${err.message}`));
		await new Promise((r) => setTimeout(r, 1200));
	}
}

async function onGranted(client, discordId) {
	try {
		const user = await client.users.fetch(discordId);
		await user.send({ embeds: [grantedEmbed()] });
	} catch { /* DMs closed - the items are in the game either way */ }
}

module.exports = { isBoosting, check, verify, scanExisting, onGranted, thankYouEmbed };
