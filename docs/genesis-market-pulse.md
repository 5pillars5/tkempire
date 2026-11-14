# Genesis Market Pulse — read-only staging

Date: 2026-11-12
Status: staging branch only; not deployed or connected to Genesis trading decisions.

## Scope

The new `/genesis-market-pulse.html` displays observed 20-second market movement using the existing `/api/genesis/prices` source for the fixed BNB, SOL and APT Hyperliquid perpetual mid-prices. It calculates observed log return in basis points, latest interval speed, and acceleration. It is not a price prediction or trading signal.

Browser-session sampling uses three spaced samples and source, timestamp, schema and freshness validation. Irregular or expired samples produce COLLECTING or STALE. No Polymarket settlement pricing, executable quotes, API keys, wallet access, execution or fabricated profitability claims are involved.

## Next phase

Independently confirm BTC/ETH active Polymarket market identity, expiry, settlement reference, actual YES/NO bid/ask/depth, feed latency and costs. Persist timestamped decisions and settle the same event IDs; measure out-of-sample net performance, calibration, abstention and uncertainty against a no-skill baseline. Do not integrate into trading admission until independently verified and operator approved.

## Verification and release

Local tests: `node --test tests/genesis-market-pulse.test.js` (4/4 PASS before GitHub staging). Production website integration, full regression, responsive browser QA and VPS readback have not been completed. Feature is isolated from production.

MILESTONE_CHECKPOINT=NOT_YET_WRITTEN_TO_VPS
