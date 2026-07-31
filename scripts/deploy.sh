#!/usr/bin/env bash
# Publish public/ to the nginx webroot.
#
# Assets are fingerprinted into their URLs (styles.css?v=<hash>) because the
# server sends them with a one-hour max-age. Without this, a returning visitor
# keeps running the previously cached script and simply never receives a
# deploy — which is exactly how a stale build stayed live.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/public"
DEST="${DCP_WEBROOT:-/var/www/dailycolorpuzzle}"

css_hash="$(md5sum "$SRC/styles.css" | cut -c1-10)"
js_hash="$(md5sum "$SRC/game.js" | cut -c1-10)"
earth_hash="$(md5sum "$SRC/earth.js" | cut -c1-10)"
battle_hash="$(md5sum "$SRC/battle.js" | cut -c1-10)"
fx_hash="$(md5sum "$SRC/fx.js" | cut -c1-10)"
map_hash="$(md5sum "$SRC/worldmap.js" | cut -c1-10)"

mkdir -p "$DEST"
cp "$SRC/styles.css" "$SRC/game.js" "$SRC/earth.js" "$SRC/battle.js" "$SRC/fx.js" "$SRC/worldmap.js" \
   "$SRC/privacy.html" "$DEST/"

# Rewrite the asset references with the current fingerprints. Every page that
# loads an asset needs the same treatment, or the page left out keeps serving
# whatever the browser cached an hour ago.
stamp() {
  sed -e "s|href=\"styles\.css[^\"]*\"|href=\"styles.css?v=$css_hash\"|g" \
      -e "s|src=\"game\.js[^\"]*\"|src=\"game.js?v=$js_hash\"|g" \
      -e "s|src=\"earth\.js[^\"]*\"|src=\"earth.js?v=$earth_hash\"|g" \
      -e "s|src=\"battle\.js[^\"]*\"|src=\"battle.js?v=$battle_hash\"|g" \
      -e "s|src=\"fx\.js[^\"]*\"|src=\"fx.js?v=$fx_hash\"|g" \
      -e "s|src=\"worldmap\.js[^\"]*\"|src=\"worldmap.js?v=$map_hash\"|g" \
      "$SRC/$1" > "$DEST/$1"
}
stamp index.html
stamp battle.html

chmod 644 "$DEST"/*
echo "deployed  css=$css_hash  js=$js_hash  earth=$earth_hash  battle=$battle_hash  fx=$fx_hash  map=$map_hash"
grep -ho 'styles\.css?v=[a-f0-9]*\|game\.js?v=[a-f0-9]*\|earth\.js?v=[a-f0-9]*\|battle\.js?v=[a-f0-9]*\|fx\.js?v=[a-f0-9]*\|worldmap\.js?v=[a-f0-9]*' \
  "$DEST/index.html" "$DEST/battle.html"
