# PL:BR Discord setup, step by step

Everything secret (the bot token, the Bloxlink key, the sync key and the Open Cloud key)
goes only into **Railway → Variables** and the **Roblox Secrets store**. It never goes in
code or git.

## 1. Discord application (bot)
1. Go to https://discord.com/developers/applications → **New Application** → name it `PL:BR`.
2. **General Information**: copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
   Optionally upload the PL:BR logo as the app icon.
3. **Bot** tab:
   - Set the username and avatar.
   - Turn **off** "Public Bot" so only you can invite it.
   - Leave every Privileged Gateway Intent **off**; none are needed.
   - **Reset Token** → copy it straight into Railway as `DISCORD_TOKEN`. Don't share it or
     paste it anywhere else.
4. **Invite the bot.** Replace `APP_ID` in this link, open it, and pick your server:
   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=268528784
   ```
   `268528784` grants View Channels, Send Messages, Embed Links, Read Message History,
   Manage Roles, Manage Channels (for `/nuke`), Manage Messages (auto-moderation) and
   View Audit Log (who moved or muted someone, in the voice logs). It does **not**
   need Administrator, unless you `/nuke` a channel whose overrides use permissions the bot
   doesn't have itself.
5. **Role order:** Server Settings → Roles → drag the bot's role **above** all PL:BR
   progression roles. The bot can only manage roles below its own.
6. **Copy IDs.** User Settings → Advanced → Developer Mode on. Then right-click to copy:
   - the server → `DISCORD_GUILD_ID`
   - `#kill-leaderboard` → `KILL_LEADERBOARD_CHANNEL_ID`
   - `#win-leaderboard` → `WIN_LEADERBOARD_CHANNEL_ID`

### Channels
| Category | Channels |
|---|---|
| PL:BR INFORMATION | `#plbr-announcements`, `#plbr-updates` |
| PL:BR STATISTICS | `#player-stats`, `#kill-leaderboard`, `#win-leaderboard`, `#account-linking` |

- Make `#kill-leaderboard` and `#win-leaderboard` read-only for @everyone, and let the bot
  send messages there.
- The bot posts ONE message in each leaderboard channel and keeps editing it.

## 2. Bloxlink
Bloxlink stays installed as it is. The PL:BR bot only reads who is verified.
1. Go to https://blox.link/dashboard → your server → find the **API key** section, and
   generate a **server API key** for this server.
2. Paste it into Railway as `BLOXLINK_API_KEY`.

Members verify with Bloxlink's own `/verify`. The PL:BR bot calls Bloxlink's documented
`discord-to-roblox` lookup and stores the **Roblox UserId**.

## 3. Railway
1. https://railway.com → **New Project** → **Deploy from GitHub repo** → `plbr-discord`.
2. In the project: **+ New** → **Database** → **PostgreSQL**.
3. Click the `plbr-discord` service → **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (a reference to the database, not a copied value).
   - Add the rest from `.env.example`: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
     `DISCORD_GUILD_ID`, the two channel IDs, `BLOXLINK_API_KEY` and `ROBLOX_SYNC_KEYS`.
   - `ROBLOX_SYNC_KEYS` is a long random string you create yourself, 48 or more characters.
     For example, a password manager's generator with letters and digits only.
4. **Settings → Networking → Generate Domain.** This gives the public API URL used by the game.
5. **Deploy.** The logs should show:
   - `[db] applied migration`
   - `[api] listening`
   - `[bot] online as …`
   - `registered 6 slash commands`

   The service restarts on its own if it crashes, and it runs 24/7 without your PC.
   Railway's Hobby plan is needed after the trial.

## 4. Roblox
1. Creator Dashboard → PL:BR → **Secrets** → **Create secret**:
   - name `PLBR_SYNC_KEY`
   - value: the same string as `ROBLOX_SYNC_KEYS`
   - domain: your Railway domain, e.g. `*.up.railway.app`
2. Game Settings → Security → **Allow HTTP Requests** = on.
3. In Studio, set `DiscordStatsSync.API_URL` to `https://<your-railway-domain>` and **publish**.

### Optional: Open Cloud (backfill + `/refresh` from saved data)
1. Creator Dashboard → **Open Cloud → API Keys → Create API Key**.
2. **Access permissions** → add the PL:BR experience with **read-only** access:
   - Data stores: `universe-datastores.objects:read`
   - Ordered data stores: entry `read`
3. **Accepted IP addresses** = `0.0.0.0/0`, because Railway's IPs change. Set an expiry if
   you like.
4. Railway variables:
   ```
   ROBLOX_OPEN_CLOUD_KEY=<the key>
   ROBLOX_UNIVERSE_ID=<PL:BR universe id>
   ROBLOX_STATS_DATASTORE=DumpPlayerStats_v1
   ROBLOX_STATS_ENTRY_KEY=Player_{userId}
   ROBLOX_STATS_FIELDS=kills=Kills,wins=Wins,deaths=Deaths
   ROBLOX_KILLS_ORDERED_DATASTORE=PLBR_GlobalKills_v1
   ROBLOX_WINS_ORDERED_DATASTORE=PLBR_GlobalWins_v1
   ```

## 5. Checks
- `/link`: says you're verified (after Bloxlink `/verify`).
- `/stats` matches your saved totals in game. `/stats @someone` works for another member.
- Get a kill: within about a minute, which is the game's autosave interval, `/stats` goes
  up and your roles update.
- Win a match: the update is near-instant.
- Leaderboard channels show the top 10 with 🥇🥈🥉.
- Railway "Restart" → the bot comes back and keeps the same leaderboard messages.
