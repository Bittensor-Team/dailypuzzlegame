# Slack bot

Two independent halves. Configure either, or both.

* **Announcements** — a daily solve worth announcing, and every finished
  battle, are posted to a channel.
* **`/puzzle`** — a slash command for the standings, the battle leaderboard,
  and battles being played right now.

Everything lives in `/etc/dailycolorpuzzle.env` on the server, alongside the
Telegram token. That file is outside the repo and mode 0600; nothing here is
ever sent to a browser.

With no Slack settings present the bot is simply off — the site behaves exactly
as it does today.

---

## 1. Create the app

<https://api.slack.com/apps> → **Create New App** → **From scratch**. Name it
(*Daily Color Puzzle*) and pick your workspace.

## 2. Announcements

The simplest route is an incoming webhook — one URL, no scopes, no OAuth.

1. **Incoming Webhooks** → toggle **On**.
2. **Add New Webhook to Workspace**, choose the channel, **Allow**.
3. Copy the URL (`https://hooks.slack.com/services/T…/B…/…`).

Add it to `/etc/dailycolorpuzzle.env`:

```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...
```

*Or*, if you would rather post as a bot user (needed if you want the bot to
appear in the member list, or to post to several channels later):

**OAuth & Permissions** → add the `chat:write` bot scope → **Install to
Workspace** → copy the bot token, and invite the bot to the channel with
`/invite @Daily Color Puzzle`.

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL=#puzzle
```

The webhook wins if both are set.

## 3. The `/puzzle` command

1. **Basic Information** → **App Credentials** → copy the **Signing Secret**.
2. **Slash Commands** → **Create New Command**:
   * Command: `/puzzle`
   * Request URL: `https://puzzle.landready.site/api/slack/command`
   * Short description: `Daily Color Puzzle standings`
   * Usage hint: `[top | live | share]`
3. Reinstall the app if Slack asks.

```
SLACK_SIGNING_SECRET=...
```

Every request Slack sends is signed, and this endpoint refuses anything that
is not: no signature, a wrong one, a stale timestamp, or a body that does not
match what was signed. The signing secret is what makes the endpoint safe to
expose, so the command stays off until it is set.

### What it answers

| Command | Reply |
| --- | --- |
| `/puzzle` | Today's standings — top 10, moves and times, with totals |
| `/puzzle top` | Battle leaderboard, all-time wins |
| `/puzzle live` | Battles being played right now |
| `/puzzle share` | Today's standings, posted **to the channel** |
| `/puzzle help` | The list above |

Everything except `share` is ephemeral — only the person who typed it sees the
answer, so checking the score does not interrupt the channel.

## 4. Check the hookup

```sh
node scripts/slack-test.js
```

Prints what is configured and posts a connection check to the channel.

## 5. Apply

```sh
sudo nano /etc/dailycolorpuzzle.env     # add the settings above
pm2 restart dcp-api
```

Confirm it took:

```sh
curl -s localhost:8791/api/health
pm2 logs dcp-api --lines 20
```

A misconfigured Slack logs a line and is otherwise ignored — a slow or broken
Slack can never delay or fail a player's score submission.

---

## Public distribution (installing into other workspaces)

Slack's *Enable Features & Functionality* screen lists six things. **You do not
need all six.** What this app actually uses:

| Feature | Needed? | Why |
| --- | --- | --- |
| **Bots** | yes | The app posts and answers as a bot user |
| **Permissions** | yes | Scopes `commands` and `incoming-webhook` |
| **Incoming Webhooks** | yes | Each install gets its own channel to post into |
| **Slash Commands** | yes | `/puzzle` |
| **Event Subscriptions** | recommended | Only to hear `app_uninstalled`, so a removed workspace stops being posted to |
| **Interactive Components** | **no** | Our buttons are plain links to the site; nothing posts back to us |

The real requirement is **OAuth** — a workspace clicks *Add to Slack*, Slack
sends a code, and the server trades it for that workspace's own webhook and bot
token. That is built: `/api/slack/install`, `/api/slack/callback`, and a
`slack_installs` table holding one row per workspace.

The signing secret does **not** change per install — it belongs to the app — so
one `SLACK_SIGNING_SECRET` verifies `/puzzle` from every workspace.

### Settings

1. **Basic Information → App Credentials**: copy the **Client ID** and
   **Client Secret**.

   ```
   SLACK_CLIENT_ID=...
   SLACK_CLIENT_SECRET=...
   ```

2. **OAuth & Permissions → Redirect URLs**: add
   `https://puzzle.landready.site/api/slack/callback` and save.

3. **OAuth & Permissions → Bot Token Scopes**: `commands`, `incoming-webhook`.

4. **Event Subscriptions** → **On**. Request URL:
   `https://puzzle.landready.site/api/slack/events` — Slack verifies it by
   asking the server to echo a challenge, which it does. Then **Subscribe to
   bot events** → add `app_uninstalled`.

5. **Manage Distribution** → work through the checklist → **Activate Public
   Distribution**.

### The install link

```
https://puzzle.landready.site/api/slack/install
```

Send that to anyone, or put it behind an *Add to Slack* button. It redirects to
Slack's consent screen and lands back on a confirmation page. Every install is
announced to independently; removing the app in Slack deletes the row.

`node scripts/slack-test.js` reports how many workspaces are installed.

### Directory listing (optional)

Public distribution lets anyone install by link. Getting *listed* in the App
Directory is a separate submission with a review — it wants a support URL, a
privacy policy (`/privacy.html` is live), screenshots and a description. Not
required to share the link.

---

## Current state

Installed on 3 Aug 2026 for the **QuitBoat** workspace, bot user
`dailycolorpuzzle`:

* Announcements — **on**, via the incoming webhook.
* `/puzzle` — **off**, waiting on `SLACK_SIGNING_SECRET`.
* Installs — **off**, waiting on `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.

The bot token that came with the app carries only the `incoming-webhook`
scope, so `chat.postMessage` would be refused; posting goes through the
webhook, which is the path this module prefers anyway. The token is not
stored — add `chat:write` and a `SLACK_CHANNEL` only if you later want the
bot to post as a member rather than through the webhook.

---

## Notes

* Nicknames are player-supplied, so `&`, `<` and `>` are escaped before they
  reach Slack.
* Tables are rendered as code blocks: Slack has no table block, and
  proportional text staggers the numbers across different name lengths.
* Announcements fire only for a genuine improvement, matching Telegram — a
  repeat submission of a worse run would otherwise spam the channel.
