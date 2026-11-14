# Genesis Auto TESTNET private monitoring — initial exchange view

This is **not** an execution client. `/genesis-auto.html` is a private, read-only view that polls a Vercel GET-only API at `/api/genesis/auto-monitor` about every 8 seconds while the page is open.

## Deployment requirements

Configure `GENESIS_AUTO_TESTNET_ACCOUNT` on the Vercel `tkempire` project to the **master TESTNET account address** (never the signing agent key), and `GENESIS_AUTO_VIEW_KEY` to an independent long high-entropy viewer passphrase. The browser prompts for that passphrase and retains it in memory only. Do not reuse a trading key, the server-side `GENESIS_STATUS_TOKEN`, or the testnet agent private key. The endpoint is **503** until both values are configured, **401** on unauthorized requests, and returns no data on upstream errors.

The Vercel server fetches only `https://api.hyperliquid-testnet.xyz/info` using three public read-only POST info methods: `clearinghouseState`, `frontendOpenOrders`, `userFills`. No signing, approvals, orders, wallet secrets, production VPS access or mainnet endpoints exist in this code. Only APT and BNB positions and fills are returned; all account-wide positions/orders are counted. Detailed fill response fields such as transaction hash, order ID, account address and CL oid are stripped by an allowlist. Day P&L is the sum of **retrieved** APT/BNB USDC-denominated `closedPnl - fee` fills for the current UTC day, not independently reconciled Genesis profits or full account returns. The API does not establish the auto worker is running and makes no attribution of fills to Genesis without verified worker records.

## Next safe enhancement

A separate, authenticated, loopback-only VPS publisher can project the auto-worker journal + service heartbeat + validated exchange order correlation through a narrowly scoped Nginx read-only gateway. Gate it behind the existing server-side gateway credentials, restrict its schema and freshness, and integrate into this monitor after review. Never publish raw SQLite, signing keys, approval records, signal fingerprints, strategy internals, or write methods.

## Verification

Run `node --test tests/genesis-auto-monitor.test.js` in the repository. In preview, test missing/mistyped key, no positions, open positions and fills, stale/unavailable exchange, mobile rendering and no public data exposure. This branch must not alter production PAPER mode or existing Genesis AUTO execution.
## Preview deployment

The Vercel preview must have its own `GENESIS_AUTO_VIEW_KEY` and `GENESIS_AUTO_TESTNET_ACCOUNT` values; after editing environment variables create a new preview deployment so they take effect. The preview is intentionally not the production website. Do not set the independent private view key on the production project until privacy and authenticated exchange response checks pass.

## Worker-journal bridge (VPS deployment contract)

The frontend now supports a **separate** optional VPS publisher with a strict contract and a fail-closed gate. The publisher is not installed by these GitHub changes. Do not treat Hyperliquid exchange fills as confirmed Genesis worker executions.

**Required VPS installation by operator/Codex:**

1. Inspect the exact current schema of \`/root/tkempire/isolated/genesis_testnet_auto_worker/\` and the journal/execution state it actually writes. Capture a consistent SQLite read-only snapshot (\`file:...?mode=ro\`, immutable only if the journal is quiescent, never copy SQLite WAL without consistency safeguards). Do not mutate the trading database or import code that initializes it.
2. Implement a separate read-only publisher. Run as an unprivileged user with only read access to approved worker data (or a separate root-owned read-only snapshot producer). Serve **127.0.0.1 only**, with a bounded GET status response, no commands, no secrets, no raw DB, no write methods.
3. Emit this allowlisted JSON v1 only when independently verified:
\`\`\`json
{
  "schema_version": 1,
  "source": "GENESIS_AUTO_TESTNET_MONITOR",
  "publication_scope": "PRIVATE_READ_ONLY",
  "execution_authority": "none",
  "network": "TESTNET_ONLY",
  "generated_at": "2026-11-12T16:00:00Z",
  "service": {
    "state": "RUNNING",
    "heartbeat_at": "2026-11-12T16:00:00Z",
    "restarts": 0,
    "production_mode": "PAPER",
    "mainnet_authorized": false,
    "auto_testnet_enabled": true
  },
  "counters": {
    "signals_eligible": 0,
    "signals_blocked": 0,
    "entries_submitted": 0,
    "entries_filled": 0,
    "exits_reconciled": 0,
    "errors": 0
  },
  "events": []
}
\`\`\`
Counters must be based on reconciled journal evidence with documented window/scope; never set unsupported fields to zero just to satisfy schema. Events (at most 30, newest first) contain only \`id\` (opaque SHA-256 truncated hex generated using a private salt and nonpublic event identifier), \`at\` (UTC), \`coin\` (APT or BNB), \`side\` (BUY or SELL), \`stage\` (QUALIFIED, REJECTED, AUTHORIZED, BLOCKED, ORDER_SUBMITTED, ENTRY_FILLED, PROTECTED, EXIT_FILLED, CLOSED, ERROR), \`reason_code\` from the public allowlist, and optional verified numeric \`entry_price\`, \`exit_price\`, \`size\`, \`realized_pnl_usd\`, \`fees_usd\`. No fingerprint, cloid, key, wallet address, internal risk policy, raw strategy observations, source paths or private trade identifiers.
4. Add an **exact** authenticated HTTPS Nginx route \`/internal/genesis/auto-monitor\` on \`api.tkempire.io\`. Match the existing \`/internal/genesis/health\` Basic-Auth identity and credentials, GET-only, no-store, no redirects, no fallback route, loopback-only upstream; validate Nginx configuration and preserve rollback.
5. Validate 401 without credentials, 200 with approved identity and valid schema, stale heartbeat rejection, 405 mutation requests, and no public access to loopback publisher. Verify the existing Genesis Auto worker and production PAPER service remain untouched and running.
6. After the gateway works, set \`GENESIS_AUTO_WORKER_FEED_ENABLED=true\` in Vercel for **preview only**, and redeploy preview. The endpoint's \`auto-worker-feed.js\` adapter rejects stale or malformed payloads. Do not change production secrets or merge the PR until end-to-end validation and mobile QA pass.

**Important**: This dashboard is read-only. Nothing on the public website must submit, authorize, cancel, stop or restart exchange orders. The emergency stop stays in VPS operations tooling, not in a browser action.
