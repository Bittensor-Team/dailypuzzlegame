# Daily Color Puzzle

A colour-sorting puzzle with a new board every day, a shared leaderboard, and a
Telegram feed of results. Twelve tubes, ten colours, four blocks each, two empty
tubes to work with — group every colour into a tube of its own.

Live at **https://puzzle.landready.site**

## How it fits together

```
public/     static site — no build step, no framework, no dependencies
server/     Node API: accounts, scoreboard, board generation, Telegram
scripts/    deploy, backups, account admin, data generation
```

Served by nginx from `/var/www/dailycolorpuzzle`; the API runs under pm2 on
`127.0.0.1:8791` and is proxied at `/api/`.

## Two things the client is never trusted with

**The board.** Generation lives in `server/puzzle.js`, which is never served.
Shipping it would hand every visitor tomorrow's puzzle *and* a working solver —
enough to top the leaderboard by copy-paste. The browser receives only a dealt
board and the rules needed to play it, from `GET /api/board?date=`.

**The score.** The client submits its move sequence, not a number. The server
regenerates that day's board, replays every pour and undo against it, and
records a score only if the replay actually solves the puzzle. Forging a good
score costs as much work as really solving one.

## Accounts

A nickname and a password — no email, no third parties. Passwords are stored as
a scrypt hash with a per-account random salt and compared in constant time.
Signing in issues a random session token, valid 180 days. Nicknames are unique,
case-insensitively, and escaped everywhere they are displayed.

Password resets happen on the server, since there is no email on file:

```sh
node scripts/account.js list
node scripts/account.js reset  "<nickname>" "<new password>"
node scripts/account.js create "<nickname>" "<password>"
node scripts/account.js delete "<nickname>"
```

## Scoring

A day keeps your **best**, so replaying can only improve it. **Undo does not
refund a move** — it rescues a dead end, it does not buy back a lower score.
Because of that a score is no longer the length of the final solution path, so
the client sends the full action log (pours *and* undos) and the server counts
only the pours.

Dates are the player's **local** date. A board opens once that date has begun
anywhere on Earth (UTC+14) — comparing against the server's own UTC date locks
out everyone east of it.

## Deploying

```sh
./scripts/deploy.sh          # fingerprints assets, copies to the webroot
pm2 restart dcp-api          # after a server/ change
```

Assets are served with a one-hour `max-age`, so `deploy.sh` rewrites their URLs
with a content hash. Without that, returning visitors keep running the cached
build and never receive a deploy.

## Configuration

Secrets live outside the repo in `/etc/dailycolorpuzzle.env` (mode 0600):

```
TELEGRAM_TOKEN=...
TELEGRAM_CHAT_ID=...
SITE_URL=https://puzzle.landready.site/
```

Point the announcer at a chat with `node scripts/telegram-setup.js <bot-token>`
after messaging the bot. Announcements fire only when a player beats their own
best, and are shaped by rank — a crowned banner for first, medals for second and
third, a quiet line otherwise.

## Operations

```sh
./scripts/backup.sh          # nightly at 04:17 via cron; keeps 14, gzipped
```

Backups use sqlite's `VACUUM INTO` rather than copying the file — the database
runs in WAL mode and a plain `cp` can capture a torn state.

## Regenerating the map

The background world map is real coastline data, sampled into land dots:

```sh
curl -O https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson
node scripts/gen-earth.js ne_110m_land.geojson public/earth.js
```

Source: Natural Earth 1:110m land, public domain.

## Notes

- `?date=YYYY-MM-DD` loads any past day's board.
- Difficulty is three constants at the top of `server/puzzle.js`: `CAPACITY`,
  `COLOR_COUNT`, `SPARE_TUBES`. Fewer spare tubes is much harder.
- Every generated board is checked solvable before it is served.
- The interface has a dark and a light theme, following the system setting
  until the toggle is used.
