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
