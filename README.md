# PL:BR Discord integration

A custom Discord bot plus a small stats API for **PL:BR**. It runs alongside
Bloxlink: Bloxlink verifies Roblox accounts, and this bot reads those links.

- **Roblox game servers** push each player's *saved* kills / wins / deaths to the API
  (server scripts only, after the save succeeds).
- **API** (Express) checks the shared key, validates the request, and stores the
  totals in **PostgreSQL**. It's idempotent: the game sends absolute totals plus a
  forward-only revision, so duplicates or out-of-order requests can't add stats, and a
  push that would *lower* a stat is rejected. That last rule guards against a server
  that loaded zeros.
- **Bot** (discord.js) has the slash commands, keeps the leaderboard messages
  up to date, and assigns progression roles.
- **Open Cloud** (optional, read-only) lets the bot read saved data straight from the
  game's DataStores. It uses this for `/refresh`, and every 30 minutes to catch up
  anything that was missed.

```
src/
  index.js            starts the API + bot (one Railway service)
  config.js           all settings come from environment variables
  api/server.js       POST /v1/roblox/stats, GET /health
  stats/              store (idempotent upserts), K/D, role tiers
  bot/                client, commands, roles, linking, leaderboards, embeds
  services/           Bloxlink + Roblox web / Open Cloud clients
  sync/reconcile.js   Open Cloud backfill + periodic role reconciliation
  db/                 Postgres pool + SQL migrations (applied on start)
roblox/               the server-side Luau that goes into the game
test/                 npm test (needs TEST_DATABASE_URL)
```

## Commands

| Command | What it does |
|---|---|
| `/stats [player] [roblox]` | Kills, wins, kill rank, win rank, kill role, avatar |
| `/leaderboard kills\|wins` | Top 10 |
| `/rank` | Your kill and win progression, with the next milestone |
| `/refresh` | Re-checks Bloxlink and saved stats, then fixes your roles (once per minute) |
| `/link` | How to verify with Bloxlink, or which account you're verified as |
| `/leaderboard-refresh` | Admins (Manage Server): update the leaderboard channels now |
| `/ban player reason [type]` | Administrators: ban a Roblox player in the game (the game's own BanService, Normal or In-Game ban). Queued for a running game server to carry out; the result is also posted in the Manual channel |
| `/nuke` | Administrators: wipe the current channel by re-creating it in the same place with the same permissions (asks to confirm; won't touch leaderboard, Rules or Community Updates channels) |

Deaths are still synced and stored, but `/stats` doesn't show deaths or K/D: the game only
started counting deaths recently, so older totals would be wrong.

## Game logs

The game sends anti-cheat kicks and every Owner / Admin / Content Creator panel action to
`POST /v1/roblox/logs` (same key as the stats). The bot posts them in the anti-cheat and
Manual channels (`ANTICHEAT_LOG_CHANNEL`, `PANEL_LOG_CHANNEL`). Logs never ping anyone.

## Roles

There are two independent progressions (`src/stats/tiers.js`). Each player holds at most
one role from each. On startup, the bot creates any progression role that doesn't exist
yet and reuses ones that do.

- **Kills:** Recruit 0, Fighter 100, Mercenary 500, Assassin 1,000, Executioner 2,500,
  Legend 5,000, Untouchable 10,000
- **Wins:** Survivor 10, Champion 50, Elite Champion 100, Unstoppable 250, PL:BR Legend 500

## Running the tests

```
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/plbr_test npm test
```

Use an empty database: the tests wipe it first.

## Deployment

See [`SETUP.md`](SETUP.md) for the full step-by-step (Discord application, Bloxlink key,
Railway, Roblox secret, Open Cloud).
