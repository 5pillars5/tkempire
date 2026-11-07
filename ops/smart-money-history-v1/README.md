# Genesis Smart Money History V1 — observation-only

## What this actually connects

- **Existing Smart Money Monitor V1** on the Empire VPS: `/var/lib/tkempire-smartmoney-v1/signals.sqlite3`, populated by the independent `tkempire-smart-money-v1.timer`. Existing `signals.id` values are preserved by the read-only legacy exporter.
- **New durable public observation mirror:** collects from the **same public** `/api/smart-money-signals` endpoint as the VPS monitor and from `/api/smart-money-flow`, using GitHub Actions every ~15 minutes. Stores compressed UTC-day archives in `data/smart-money-history-v1/YYYY-MM-DD.json.gz` and a sanitized `LATEST.json`.
- **Important:** The public mirror is a **new capture stream**, not a historical import of the VPS SQLite. The import source is not available through the read-only operations connector at development time. No prior VPS records have been declared imported. A separate read-only export tool and tests are included for that later transfer.
- **Resolved outcome matching:** a scheduled, separate job reads archived signals, fetches Polymarket `/v2/resolutions?condition=<id>` and `/v2/tokens?condition=<id>`, matches exact `condition_id + token_id + outcome_index`, and appends statuses `PAYOUT_1`, `PAYOUT_0`, `PARTIAL_PAYOUT`, `PENDING`, `UNVERIFIED`, or `EXCLUDED`. It requires **both** observation and capture timestamps before the resolved time. It does **not** compute trade profits, win-rate claims, calibrated probabilities or authorize execution.
- **Website:** `GET /api/smart-money-history?view=summary&days=3` and `GET /api/smart-money-history?view=market&condition=0x...&token=...&days=3` read public compressed archives without GitHub credentials. The Flow Map displays verified archive status, three-day count, and selected outcome's recorded rolling 24-hour pressure readings. Gaps and missing archives remain explicitly missing, not zero.

## Data integrity and sampling caveats

1. The archive follows the current *weekly crypto-PnL leaderboard* wallet cohort and at most 70 recent trade events per wallet in the latest public Flow Map sample. Cohort changes and caps cause significant selection/incomplete-sampling bias.
2. Each flow observation is timestamped, assigned to a UTC 15-minute bucket, immutable after first capture, and includes exact outcome-token identifiers and coverage flags. It is **not a complete trade ledger** and **not** a backfilled market-wide aggregate.
3. The original public Signals feed is capped, and some signal types lack a resolvable token ID. Those remain `UNMATCHABLE_SIGNAL_IDENTITY` until source evidence exists.
4. The outcome checker does not mark a winner when market/token mapping is missing, a payout vector is invalid, the market is unsettled, or the signal's first captured timestamp is at/after resolution. It never uses an outcome title for matching.
5. GitHub scheduled jobs can run late or be skipped. Only *read-backed committed archives* count as saved history. Monitor failures or disabled workflows can create real gaps; the website reports them as missing.
6. This is a public-repository data mirror of public wallet evidence, not a store for keys, wallet credentials, private user information, or account balances.
7. The history writer uses a temporary job-scoped GitHub token with narrowly scoped `contents:write` on `main`. PR builds never receive write permission. `data/**`-only Git commits are ignored by the existing Vercel deploy rule.

## Read-only prior VPS SQLite export (operator-gated)

Only after independent hash verification of the reviewed exporter on the operator's VPS, the operator can run the script **on the VPS** with read-only `mode=ro` database access and an unused destination outside the source DB. Example *after* verified installation:

```bash
python3 -B /opt/tkempire-smartmoney-history-v1/export-legacy-sqlite.py \
  --db /var/lib/tkempire-smartmoney-v1/signals.sqlite3 \
  --output /tmp/tkempire-smartmoney-legacy-export.json
```

The tool prints `EXPORT_SHA256` and `EXPORT_READBACK=PASS`, and reports `GITHUB_IMPORT=NOT_YET_PERFORMED`. The export must undergo a separately approved and verified import. It must **not** be interpreted as a successful GitHub upload or a written Empire Milestone Registry checkpoint.

## Verification gate

- GitHub Actions `Genesis Smart Money Durable Historian`: immutable snapshot, source trust, duplicate IDs, token resolution, post-resolution leakage, read-only importer and historical API tests.
- `Genesis Smart Money Outcome Evidence Match`: bounded review of unresolved market outcomes; strict mapping validation.
- `data/smart-money-history-v1/LATEST.json` must exist with a UTC bucket, archive path and compressed SHA-256.
- Read back the referenced daily archive and verify actual persisted snapshots and original source signal IDs; then verify the public `/api/smart-money-history` summary reports the count.
- Before claiming the **Empire milestone completed**: verify Genesis `PAPER` / maintenance safety gates and unchanged live service health, write to `/root/tkempire/data/genesis/milestones/` and read back `LATEST.json`, history, Markdown and record with SHA-256 consistency. These VPS steps have **not** been performed by this GitHub-side work.

**TRADING_AUTHORITY=NONE · CALIBRATED_PROBABILITY=NOT_VERIFIED · VPS_LEGACY_IMPORT=NOT_YET_PERFORMED**


## Hash-verified original VPS SQLite export / migration handoff

The earlier generic exporter was a preparatory tool only. Use the **new**
`export-verified-vps-sqlite.py` to prove original DB and WAL file hashes and a
consistent SQLite backup SHA-256. The exporter only queries the source in
`mode=ro`, never writes its tables, does not stop the monitor timer, does not
change trading and never uploads source material. It creates a new local
`root`-only JSON export file and prints both source and output SHA-256 hashes.

On the operator's VPS, use the reviewed
`run-verified-vps-export.sh` helper (SHA-verify that helper before execution).
The helper downloads the two Python source files from reviewed `main`, compares
each file to its pinned SHA-256, executes the read-only snapshot/export, and
reports `SOURCE_EXPORT_PATH` plus `EXPORT_SHA256`. If the WAL/DB changes
during snapshot, missing credentials, permissions, or schema mismatch occur,
it fails instead of claiming success.

**Do not publish the JSON export directly to the public repository.** Pass the
verified export through the separate `reconcile-legacy-export.js` validation
and staging operation. For a *local checkout* that contains the mirrored daily
archives:

```bash
node ops/smart-money-history-v1/reconcile-legacy-export.js \
 --export /path/to/verified-vps-export.json \
 --expected-export-sha256 <copy-64-hex-hash-from-VPS-exporter> \
 --mirror-dir data/smart-money-history-v1 \
 --output-dir /path/to/new-private-staging-directory
```

The command halts on missing source SHA, inconsistent original source hashes,
duplicate IDs, conflicting market identities, or core payload disagreement.
For a stable ID observed in both systems it preserves **both** original VPS
`first_seen_at` and public mirror first capture time, records the earliest
verified first seen, and does not invent historical 15-minute market-flow
snapshots from older signal events.

A successful stage creates:

- `verified-vps-sqlite-signals.json.gz` — compressed verified legacy records,
  matched IDs and source provenance (not yet published).
- `IMPORT_MANIFEST.json` — source / archive SHA-256, matched counts and
  `public_commit_performed:false`.

The tool then reads back both files and checks their hashes, row counts and
overlap counts. It **does not** modify existing daily archives or push them
to GitHub. Publication requires a separately approved review of these two
files, an explicit `public_commit_performed:true` after a real successful
GitHub commit, and a public readback of both the exact archive hash and the
signal-ID reconciliation. The fail-closed public endpoint
`/api/smart-money-legacy-history` reports `not_imported` until a verified
manifest and archive are actually available and correlating.

**Important boundary:** Exporting locally is **not** importing.
`SOURCE_SHA256=PASS` does not mean
`MILESTONE_CHECKPOINT=PASS`. The VPS milestone registry still requires an
operator-write and independent readback under the Empire Archive Protocol.
