#!/usr/bin/env bash
# Nightly snapshot of the scoreboard database. Keeps the last 14, gzipped.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${DCP_DB:-/var/lib/dailycolorpuzzle/scores.db}"
DEST="${DCP_BACKUP_DIR:-/var/lib/dailycolorpuzzle/backups}"
KEEP="${DCP_BACKUP_KEEP:-14}"

mkdir -p "$DEST"
out="$DEST/scores-$(date +%Y%m%d-%H%M%S).db"

node "$HERE/backup-db.js" "$DB" "$out"
gzip -f "$out"

# Prune anything older than the newest KEEP snapshots.
ls -1t "$DEST"/scores-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

kept="$(ls -1 "$DEST"/scores-*.db.gz 2>/dev/null | wc -l)"
echo "$(date -Is) backed up to ${out}.gz ($(du -h "${out}.gz" | cut -f1)), ${kept} kept"
