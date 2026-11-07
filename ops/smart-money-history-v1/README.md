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
