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

## Stat farming / alt farming detection (logs only)

The game's anti-cheat (`Modules.AntiCheatFarming`) sends server-authoritative events to
`POST /v1/roblox/farm`: match rosters, every elimination (Storm's kill credit), wins and play
sessions. The bot keeps 30 days of them (`FARM_RETENTION_DAYS`) and scans them
(`src/farming/`) for:

- **Repeated eliminations:** the same opponent eliminated 10/15/25+ times within 60 minutes
  (or 30+ in 24 hours). Every elimination timestamp is listed.
- **One-sided pairs:** two players who meet often, where one almost never wins the fights.
- **Several accounts feeding one player:** 3+ accounts each eliminated 5+ times in 24 hours,
  including whether they're young accounts and whether they show up together (a group).
- **Repeated pairing:** the same two accounts in many small matches.
- **Stat patterns:** for example 4 kills for 60 wins, big jumps in an hour, kills per hour of
  tracked play, and win rate.

Indicators add up to a score, giving **Low**, **Medium** or **High**. One weak signal is never
reported on its own. Each incident is ONE embed in the anti-cheat channel, and it's edited as
the evidence grows. It is never re-posted while the incident is still going. Every threshold
can be changed with an environment variable (`src/farming/config.js`). **Nothing is ever done
to the player:** no kick, no ban, no message, no stat change. Staff review it.

## Moderation and server logs

- **Auto-moderation** deletes Discord invite links (`discord.gg/`, any `.gg/`, `discord.com/invite/`)
  and slurs, also disguised ones, and DMs the member why. **Anti-spam** spots the same message
  3+ times within 60 s (`SPAM_REPEATS`, `SPAM_WINDOW_SECONDS`) and deletes all of that member's
  recent messages. The server owner, administrators and Manage Server members are never moderated.
- **join-logs:** Discord joins (the bot) and game joins (the game). Each embed says which.
- **message-logs:** every deleted or edited message, plus what auto-moderation removed.
- **voice-logs:** joins, leaves and moves between calls, server and self mute and deafen,
  camera, and screen share.

Needs the **Message Content Intent** (Developer Portal) and the **Manage Messages** and
**View Audit Log** permissions.

## Server Booster rewards

Boosting the server (Discord's own boost status / the Server Booster role) earns the
**Boost FAL** and **Boost AA-12** in game, plus a one-time thank-you DM.

1. The bot sees the boost (instantly with the Server Members Intent on; otherwise via
   `/link`, `/refresh` and the 30-minute re-check of linked members) and records it.
2. If the member's Roblox account is linked, the reward waits for that **Roblox UserId**;
   if not, it waits until they `/link`.
3. Game servers ask `POST /v1/roblox/rewards/pending` for their online players, grant the
   skins through the inventory (skipping anything already owned), then confirm with
   `POST /v1/roblox/rewards/confirm`. The bot re-checks with Discord that the member is
   still boosting before handing anything out.
4. Granted once per member and once per Roblox account. Items are never taken back.

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
