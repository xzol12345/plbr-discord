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
| `/stats [player] [roblox]` | Kills, wins, deaths, K/D, kill rank, win rank, avatar |
| `/leaderboard kills\|wins` | Top 10 |
| `/rank` | Your kill and win progression, with the next milestone |
| `/refresh` | Re-checks Bloxlink and saved stats, then fixes your roles (once per minute) |
| `/link` | How to verify with Bloxlink, or which account you're verified as |
| `/leaderboard-refresh` | Admins (Manage Server): update the leaderboard channels now |

K/D = kills ÷ deaths. With 0 deaths, the K/D is just the kill count.

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
