# Genesis verified PAPER trading history — guarded release

This release adds an **independent** complete verified closed-PAPER history view. It does **not** access TESTNET exchange positions, publish source ledgers, or change execution permissions. Website deployment by itself does **not** publish any history: the API defaults to HTTP 503 until specifically approved.

## Components

- `history_publisher.py`: independent root-only canonical ledger projection at `127.0.0.1:5098/history?page=N`; requires `GENESIS_HISTORY_PUBLISH_ENABLED=true`. It has no order or trading functions.
- `/internal/genesis/history?page=N`: **NOT installed by this repository change**. A reviewed authenticated Nginx exact route is required. It must mirror the protected `/internal/genesis/signals` Basic Auth and use the same authorization controls, proxying only GET requests to localhost port 5098. Preserve the query string and never expose port 5098 publicly.
- `/api/genesis/trade-history?page=N`: Vercel read-only contract verifier and allowlist, additionally gated by `GENESIS_HISTORY_PUBLICATION_ENABLED=true`. Uses existing approved server-side Genesis status credentials. No secrets passed to browser.
- `genesis-signals.html`: existing Closed Trades tab now pages through the independently verified historical data, 50 records per page.

## Prerequisites (VPS operator / Codex)

1. Inspect live service, existing Nginx gateway, private HMAC key and canonical ledger availability **read only**. Confirm the private HMAC key is root-owned mode `0600` and the ledger passes one-to-one matching.
2. Validate complete-ledger projection against the standalone `audit_closed_ledger.py` audit: eligible count = published verified count, excluded = raw CLOSED_RECORDED count minus verified; confirm source timestamps and P&L denominations. Never print raw ledger, account IDs or key values.
3. Run Python fixture tests and Node API/UI tests. Audit input size bounds, symlink protection, fail-closed unknown states, HMAC ID stability, handling of ledger rotations and duplicate closures.
4. Create verified, hashed configuration backups before deploying. Install code to a root-owned directory and a **read-only**, systemd-isolated HTTP process. The current fail-closed reader explicitly requires root-owned canonical files and a root-owned mode-0600 HMAC key, so the service must have authorized access (for example a tightly sandboxed root service) unless a separately tested narrow privileged reader is implemented. Do not widen private file permissions.
5. **Before enabling any public route**, test loopback 503 when gate off, no WRITE methods, unknown/stale paper health and malformed ledger rejection. Check service sandboxes.
6. Configure an exact Nginx route with the existing `auth_basic` policy. Check `nginx -t`, reload without changing Genesis trading runtime, test unauthenticated `401`, valid credentials `200` only after upstream gate on, and no raw/source fields. Distinguish HTTP `503` when intentionally gated.
7. Enable the Vercel gate `GENESIS_HISTORY_PUBLICATION_ENABLED=true` **only after** the VPS route returns a fresh authenticated, canonical-verified page for every page of history. Do not embed this gate, keys or credentials in browser HTML.
8. Verify the public first page, final page, revision stability and coverage counts through Vercel. Check mobile UX, error handling, backend service health and trading configuration unchanged.
9. Update Empire milestone registry **only after** backup, verification, healthy runtime and checkpoint readback. If any gate fails, roll back the publisher and keep API gated.

## Data/accounting contract

- **All verified** one-to-one PAPER open/CLOSED_RECORDED pairs from the bounded canonical ledger, without a 90-day presentation cutoff.
- A stable keyed revision detects ledger changes while users page through history.
- Separate counts: total closed records, eligible verified records and excluded/unverified records. Exclusions are **not** reported as wins, losses or missing positions.
- Strict allowlisted per-trade fields: opaque ID, asset, side, open/close times, entry/exit prices, recorded realized P&L, categorical result, explicit evidence.
- `LEDGER_UNIT_UNVERIFIED` is not USD, USDC or trade-value accounting; no conversion or invented fees, quantity, confidence or reason.
- Page size 50 and max 400 pages is a safety envelope; if the underlying ledger grows beyond supported limits, a versioned, audited pagination/archive design is required before claiming unbounded all-time coverage.

## Exit criteria

`HISTORY_PUBLICATION=PASS` only when each page is accounted for, the public endpoint is HTTP 200 with correct coverage and evidence, raw records remain private, old approved endpoints still work, and the running engine remains healthy.

**Important:** Deploying this GitHub code is not evidence of publication. The separate VPS gateway and Vercel gate require a dedicated verified operator release.
