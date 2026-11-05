// K/D = kills / deaths. With zero deaths the ratio is the kill count itself
// (the convention most shooters use) - never Infinity or NaN.
function kdRatio(kills, deaths) {
	const k = Math.max(0, Number(kills) || 0);
	const d = Math.max(0, Number(deaths) || 0);
	const raw = d === 0 ? k : k / d;
	return Math.round(raw * 100) / 100;
}

function formatKd(kills, deaths) {
	return kdRatio(kills, deaths).toFixed(2);
}

module.exports = { kdRatio, formatKd };
