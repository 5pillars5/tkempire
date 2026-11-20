# Wallet Watch persistent archive and Telegram delivery

This subsystem is independent from Genesis execution. It monitors PUBLIC Polymarket trade activity for the fixed eight-wallet source-controlled cohort. It does not access trading accounts or the Empire VPS.

## Collector and durable history

- GitHub Actions workflow: .github/workflows/wallet-watch-history.yml
- Runs on main after validated CI; best-effort every 10 minutes at 03,13,23,33,43,53 UTC. Not a continuous WebSocket or guaranteed schedule.
- Three cursor-paginated pages of up to 200 recent activities per watched wallet, last 24 hours. Missing events remain possible.
- Writes compressed append-only-by-event archives to data/wallet-watch-history-v1/YYYY-MM-DD.json.gz, plus LATEST.json for scan metadata and per-wallet coverage. After write, independently reads back and checks SHA-256.
- View verified history via /api/wallet-watch-history?days=3&limit=60 with an optional wallet address. Max 7 days, 100 rows; limited sample, not exhaustive.
- PR jobs validate code and cannot write. The separate singlewriter concurrency guard prevents overlapping scheduled collectors. No direct VPS connection.

## Telegram: disabled until independently verified

The system reads these GitHub Actions repository settings on main only:

1. Repo variable WALLET_WATCH_ALERTS_ENABLED = true (set only after destination verification).
2. Repo secret WALLET_WATCH_TELEGRAM_BOT_TOKEN = dedicated alert-bot token.
3. Repo secret WALLET_WATCH_TELEGRAM_CHAT_ID = verified numeric recipient chat ID.

Use a separate alert bot, not the live Genesis execution bot. Enter secrets in GitHub Settings > Secrets and variables > Actions. Never paste tokens or chat IDs into public source, logs, issues, or ChatGPT. First, independently confirm that the intended recipient owns the chat and has started the bot.

The first enabled scan initializes a silent DELIVERY.json baseline and never sends historical backfill. Later scans deliver one HTML digest for new unacknowledged observations >=250 USDC, no older than 30 minutes. A Telegram-confirmed message is acknowledged in GitHub with readback. A send succeeded but ack write failed can cause duplicate notices; this is at-least-once delivery, not exactly once. If any wallet feed is unavailable or capped, alerts pause rather than infer activity. A scheduled outage can miss alerts.

Public archive records include public on-chain trade metadata. DELIVERY.json contains event IDs and acknowledgment timestamps but no recipient chat IDs or credentials.

## Release and operational validation

1. Pass offline node tests: tests/wallet-watch-history.test.js and tests/wallet-watch.test.js.
2. Verify Vercel preview page and bounded history API, then release the PR.
3. Verify actual first scheduled GitHub Actions archive file and independent LATEST.json readback plus compressed hash, then public history endpoint.
4. Configure and verify dedicated Telegram destination separately; enable alert variable only after a controlled harmless test with operator authorization.
5. Verify live scheduled delivery and acknowledgment readback before claiming Telegram notifications are operational.
6. VPS milestone checkpoint is separate: the Empire registry under /root/tkempire/data/genesis/milestones/ is not written by this workflow, and current live trade/service state must be verified independently.

TRADING_AUTHORITY=NONE
TELEGRAM_DELIVERY=OFF_UNTIL_VERIFIED
VPS_MILESTONE_CHECKPOINT=NOT_YET_WRITTEN
