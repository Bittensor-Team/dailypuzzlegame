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

## 4. Apply

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

## Notes

* Nicknames are player-supplied, so `&`, `<` and `>` are escaped before they
  reach Slack.
* Tables are rendered as code blocks: Slack has no table block, and
  proportional text staggers the numbers across different name lengths.
* Announcements fire only for a genuine improvement, matching Telegram — a
  repeat submission of a worse run would otherwise spam the channel.
