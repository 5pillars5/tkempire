#!/bin/sh
# TK Empire Smart Money V1 legacy source export — safe operator-only helper.
# Downloads and verifies exact reviewed Python sources, then performs
# an isolated read-only SQLite snapshot/export; NEVER uploads or trades.
set -eu
umask 077
if [ "$(id -u)" -ne 0 ]; then
  echo 'VPS_EXPORT=BLOCKED root_required'
  exit 2
fi
DB='/var/lib/tkempire-smartmoney-v1/signals.sqlite3'
OUTDIR='/root/tkempire/backups/milestones'
BASE='https://raw.githubusercontent.com/5pillars5/tkempire/main/ops/smart-money-history-v1'
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$(mktemp -d /tmp/tkempire-legacy-export.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
curl -fLsS --max-time 25 --retry 2 "$BASE/export-verified-vps-sqlite.py" -o "$TMP/export-verified-vps-sqlite.py"
curl -fLsS --max-time 25 --retry 2 "$BASE/export-legacy-sqlite.py" -o "$TMP/export-legacy-sqlite.py"
printf '%s  %s\n' \
  '5891e8490c1ae6b4db6d0740e119f9d6a2ef39986228c7da9cc42620f500945d' \
  "$TMP/export-verified-vps-sqlite.py" | sha256sum -c -
printf '%s  %s\n' \
  '016bc6e603f903d0062da1b461827229e710f831f64a0112adbdd7f9bb3ec41b' \
  "$TMP/export-legacy-sqlite.py" | sha256sum -c -
test -f "$DB"
mkdir -p "$OUTDIR"
OUT="$OUTDIR/smartmoney_vps_signals_verified_$STAMP.json"
python3 -B "$TMP/export-verified-vps-sqlite.py" --db "$DB" --output "$OUT" --retries 3
echo '=== OPERATOR HANDOFF (PRIVATE LOCAL FILE) ==='
sha256sum "$OUT"
echo "SOURCE_EXPORT_PATH=$OUT"
echo 'EXPORTER_DID_NOT_MUTATE_DB=TRUE'
echo 'PUBLIC_HISTORY_IMPORT=NOT_YET_PERFORMED'
echo 'GENESIS_EXECUTION_SETTINGS=UNCHANGED'
