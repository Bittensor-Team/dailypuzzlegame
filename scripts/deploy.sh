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

mkdir -p "$DEST"
cp "$SRC/styles.css" "$SRC/game.js" "$SRC/earth.js" "$SRC/privacy.html" "$DEST/"

# Rewrite the asset references with the current fingerprints.
sed -e "s|href=\"styles\.css[^\"]*\"|href=\"styles.css?v=$css_hash\"|g" \
    -e "s|src=\"game\.js[^\"]*\"|src=\"game.js?v=$js_hash\"|g" \
    -e "s|src=\"earth\.js[^\"]*\"|src=\"earth.js?v=$earth_hash\"|g" \
    "$SRC/index.html" > "$DEST/index.html"

chmod 644 "$DEST"/*
echo "deployed  css=$css_hash  js=$js_hash  earth=$earth_hash"
grep -o 'styles\.css?v=[a-f0-9]*\|game\.js?v=[a-f0-9]*\|earth\.js?v=[a-f0-9]*' "$DEST/index.html"
