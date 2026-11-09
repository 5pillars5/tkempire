# Genesis Signals public dashboard — staged contract

Date: 2026-11-09
Scope: read-only PAPER-only website presentation aligned with Smart Money signal cards.
Status: frontend and server adapter staged. NOT CONNECTED TO VERIFIED GENESIS SIGNALS.
No production VPS changes or trading-engine configuration changes are authorized by this change.

## Existing web sources versus this feed

- Existing /api/health intentionally returns open_trades.details_public=false and trades=[]; its served_at is API freshness, NOT proof of a new trade.
- Existing /api/genesis/status contains aggregate PAPER win/loss/P&L only; it is not a per-trade signal feed.
- Existing results.html archive is historical and redacted, not live.
- Smart Money Signals is public Polymarket wallet observation. Genesis Signals is engine decision evidence. These are separate sources.
- This branch stages genesis-signals.html, /api/genesis/signals, navigation and offline tests. It does not fabricate records.

## Producer contract — not yet installed

Future authenticated HTTPS read-only GET:
https://api.tkempire.io/internal/genesis/signals

A separately reviewed, root-owned read-only VPS publisher must derive fields from canonical decision/admission evidence and paper position ledgers, not aggregate counters. The website must NOT infer executed positions from BUY/SELL observations.

Minimal JSON v1 example (empty list is only a schema illustration):

~~~json
{
  "schema_version": 1,
  "source": "GENESIS_PUBLIC_SIGNAL_PROJECTION",
  "publication_scope": "PUBLIC_APPROVED",
  "execution_authority": "none",
  "generated_at": "2026-11-09T12:00:00Z",
  "engine": { "mode": "paper", "running": true },
  "signals": []
}
~~~

Maximum 80 entries upstream, 50 published. Each entry has an opaque safe id (8–96 characters), uppercase alphanumeric asset, side BUY/SELL, stage DETECTED/QUALIFIED/REJECTED/EXPIRED/PAPER_OPEN/PAPER_CLOSED, observed_at UTC ISO timestamp, and optional original decision-time confidence (0–100), trigger, stop_loss, target, approved reason_code. The only allowed reason codes are CHECKS_PASSED, CONFIDENCE_TOO_LOW, RISK_LIMIT, MEMORY_BLOCK, MARKET_DATA_STALE, ENTRY_NOT_TRIGGERED and OTHER.

PAPER_OPEN or PAPER_CLOSED requires position_evidence = CANONICAL_PAPER_LEDGER, validated independently by the VPS publisher. Do not map paper positions from signal flags alone. Do not include strategy fingerprints, internal thoughts, credentials, account balances, private order instructions, authorization records, sizes, unverified fills/P&L, or internal paths.

## Security and deployment

The new /api/genesis/signals adapter is GET-only; uses pre-existing encrypted Vercel server credentials; fetches only the fixed HTTPS URL with no redirects; publishes only enumerated safe fields. It refuses stale data older than 120 seconds, wrong scope/source, non-PAPER engine or any execution authority. Failures and incomplete connections return no signals. The browser uses DOM textContent, not interpolated HTML, for source fields and contains no trade execution controls.

Feature gate: GENESIS_SIGNALS_PUBLICATION_ENABLED=true

Leave the flag absent/false until the canonical publisher exists, is independently validated and its public visibility is approved. "QUALIFIED" never means traded. Only a corroborated PAPER_OPEN/PAPER_CLOSED is a verified paper position.

## Required verification sequence

1. Read-only VPS inventory: find current scanner/admission source schema, decision timestamps, canonical PAPER position ledger, and true execution gates.
2. Review field-by-field mapping with a privacy/safety check. Do not mutate engine services, paper state, risk gates or market execution configuration.
3. Build/test separate allowlisted VPS publisher with bounded output, authentication and fail-closed freshness. Check 401 without credentials, 200 only for the approved identity, no unintended public raw access.
4. Run node --test tests/genesis-public-signals.test.js tests/genesis-public-api.test.js in the repository checkout.
5. Test the website at mobile and desktop sizes with approved fixture, empty fixture, disabled, stale, invalid and degraded scenarios. Check Smart Money unchanged.
6. Following operator approval, enable publisher, enable Vercel flag and verify both site and engine service health. Roll back the flag if anything fails.
7. Write an Empire Milestone Registry checkpoint on the VPS; read back LATEST.json, LATEST.md, history and record with matching SHA-256. Completion must not be asserted without full readback.

## Unresolved blocker

No verified /internal/genesis/signals publisher has been installed or read back. Public /api/health and /api/genesis/status intentionally cannot provide individual private trade detail. The new page must truthfully show FEED NOT VERIFIED until an audited, approved producer is connected.

MILESTONE_CHECKPOINT=NOT_YET_WRITTEN_TO_VPS
