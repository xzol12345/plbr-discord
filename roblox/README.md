# Roblox side (already installed in the PL:BR place)

Everything here runs in **server scripts only**. Nothing is ever sent from a LocalScript.

| Where | What |
|---|---|
| `ServerScriptService.Modules.DiscordStatsSync` | Queues each player's saved totals and POSTs them in batches to `<API_URL>/v1/roblox/stats` with the `PLBR_SYNC_KEY` secret. Sends in the background with back-off retries, so it never blocks the game. |
| `ServerScriptService.Storm` (stats section) | `Deaths` is now saved in the existing `DumpPlayerStats_v1` `Player_<UserId>` record using the same add-only save. It's kept in `player.PLBR_SavedStats`, so it doesn't appear on the player list. `pushToDiscord` runs only once the player's stats have loaded and after each successful save. |
| `ServerScriptService.Modules.StatReset` | A staff reset also zeroes Deaths and tells the API (`reset: true`). |

The original scripts are backed up in `ServerStorage.ScriptBackups.PreDiscordSync`.

## To switch it on
1. Set `DiscordStatsSync.API_URL` to the Railway URL.
2. Creator Dashboard → PL:BR → **Secrets** → add `PLBR_SYNC_KEY`. Use the same value as Railway's
   `ROBLOX_SYNC_KEYS` and restrict it to the Railway domain.
3. Game Settings → Security → **Allow HTTP Requests** = on.
4. Publish.
