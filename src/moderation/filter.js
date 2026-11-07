// What the auto-moderator removes. Pure functions (tested in test/moderation.test.js).
//   * Discord invite links: discord.gg/..., discord.com/invite/..., discord.me/..., anything ".gg/"
//   * slurs and hate terms - also when disguised with l33t-speak, spacing,
//     punctuation or stretched letters ("n i g g e r", "f@gg0t", "niiiigger")
// Short words that are ALSO parts of normal words are only matched as whole
// words ("jew" never hits "jewel" / "jewelry", "fag" never hits "fagioli").

const INVITE_RE = /\.\s*gg\s*\/|discord(?:app)?\s*\.\s*com\s*\/\s*invite\s*\/|discord\s*\.\s*me\s*\//i;

// matched anywhere once letters are normalised (unambiguous)
const SUBSTRING_TERMS = ['nigger', 'nigga', 'faggot', 'fagot', 'kike', 'tranny', 'chink', 'wetback', 'beaner', 'raghead', 'towelhead'];
// matched only as whole words (they're inside normal words otherwise)
const WORD_TERMS = ['jew', 'jews', 'fag', 'fags', 'coon', 'coons', 'spic', 'spics', 'gook', 'gooks', 'retard', 'retards', 'retarded', 'nig', 'nigs', 'kys'];

// real words that contain a term once squeezed / joined - removed before matching
const SAFE_WORDS = ['nigeria', 'nigerian', 'niger', 'snigger', 'sniggering', 'sniggered', 'chinkapin'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '£': 'l' };

// lower-case, accents off, l33t mapped
function letters(text) {
	return String(text || '')
		.normalize('NFKD').replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[0-9@$!|+€£]/g, (c) => LEET[c] || c);
}

// every letter run collapsed ("niiigger" -> "niger") so stretching doesn't hide a word
const squeeze = (s) => s.replace(/(.)\1+/g, '$1');

function check(text) {
	const raw = String(text || '');
	if (INVITE_RE.test(raw)) return { reason: 'Discord invite link' };
	const l = letters(raw);
	// 1) whole words (split on anything that isn't a letter)
	const words = l.split(/[^a-z]+/).filter(Boolean);
	for (const w of words) {
		if (WORD_TERMS.includes(w) || WORD_TERMS.includes(squeeze(w))) return { reason: 'Offensive language' };
	}
	// 2) the whole message with every separator removed: catches "n i g g e r", "n.i.g.g.e.r"
	let joined = l.replace(/[^a-z]+/g, '');
	for (const safe of SAFE_WORDS) joined = joined.split(safe).join('');
	const joinedSq = squeeze(joined);
	for (const t of SUBSTRING_TERMS) {
		if (joined.includes(t) || joinedSq.includes(squeeze(t))) return { reason: 'Offensive language' };
	}
	return null;
}

// how messages compare for anti-spam (case / spacing don't make it "different")
function spamKey(content) {
	return String(content || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = { check, spamKey, letters, SUBSTRING_TERMS, WORD_TERMS };
