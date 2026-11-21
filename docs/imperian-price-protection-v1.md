# Imperian price-protection policy — approved rule; staging monitor v1

Policy adopted by Architect on 2026-11-13. **No payment collection or production activation is authorized by this document.** This branch provides an isolated pure calculation engine and fixture tests, not an operational billing service.

## Binding membership rule

Every active member has exactly one verified wallet-bound identity and immutable original maximum subscription price, `locked_max_rate_usdc`, set only on a confirmed first payment. At each renewal: `next_renewal_usdc = min(locked_max_rate_usdc, current_public_rate_usdc)`. A member's price may fall when verified Genesis performance worsens and recover when performance improves, but never exceeds their locked maximum. No midcycle charges or automatic debits. The wallet and maximum price must not be supplied by the browser: load them from the authenticated membership store. A different wallet address is a distinct identity unless a reviewed wallet-migration policy is implemented.

Existing performance-linked ladder, all members receive the same product:
- 0–54.999...%: 30 native Polygon USDC per month
- 55–59.999...%: 49
- 60–64.999...%: 99
- 65–69.999...%: 199
- 70–100%: 300

The baseline starts at 30 **only when paid enrollment is separately approved**, not immediately. Rates are denominated in native USDC on the selected Polygon network; merchant receipt and token validation are **future work**.

## Monitor v1 (staged operating assumptions, not yet approved production thresholds)

Weekly evaluation over an independently reconciled rolling 28–31-day period containing at least 100 decisive (WIN/LOSS) closed trades. Breakevens are excluded from the win-rate denominator but included in the reconciled count. Inputs require: paper-only mode; independently verified source contract `GENESIS_PRICING_RECONCILIATION_V1`; USD-denominated net PnL verified after fees; a full risk review; immutable evidence revision digest; valid period/cutoff; timely signed/authenticated delivery by a separately reviewed publisher. This module checks the payload structure but **does not authenticate a publisher**. The public `/api/genesis/status` endpoint and `LEDGER_UNIT_UNVERIFIED` data do NOT meet the threshold and cannot authorize price changes.

- If verified win-rate falls into a lower band, stage a lower public rate for the next renewal even if the risk review blocks increases.
- If a higher band is indicated, require profitable net PnL, risk-review PASS, and two distinct qualifying weekly reviews approximately seven days apart before proposing an increase.
- On incomplete, stale, repeated, future-dated, inconsistent, unprofitable-for-increase, or otherwise unverified inputs: HOLD the published price, never infer performance.
- This version returns **proposals**, not committed changes. An independent audit-and-approval publisher must atomically persist accepted decisions, serialize overlapping workers, read back the durable state, and attach a versioned transaction/decision audit before any production billing quote changes.
- A proposed reduction does not affect already-billed periods; next renewal only. Existing members keep their locked maximum even when the public price subsequently rises.
- Prevent review gaps from silently authorizing increases. A future launch review must verify the minimum trade count, loss definition, live-vs-paper performance disclosure, window policy, drawdown limits, sustainable cost model, stale-feed grace behavior, refunds and applicable regulations. Retrospective replay and sample overlap must be scrutinized.

## Security boundaries and release gates

1. No production website, Genesis, execution, membership database, wallets, Vercel environment values, billing or deployment changes on this branch.
2. Provide a signed/verified dedicated performance publication from a separate audited read-only Genesis adapter, using **real independently reconciled USD PnL** rather than existing unverified ledger units. Never grant the website private trading credentials.
3. Create durable and access-controlled subscription records; use wallet-signature login with nonce, domain binding, expiration, and replay prevention. Verify precise onchain token/chain/from/to/amount/finality/transaction uniqueness server-side. Only after acceptance mark initial payment and locked maximum.
4. Test idempotent monitoring, window overlap, consecutive reviews, insufficient history, losses, stale feeds, abnormal drawdown, downtime, renewals, membership expiry, migrations, timezone boundaries and billing outages. Require financial/legal review for any performance-linked paid signals.
5. Require operator approval for launch; deploy behind feature gates disabled by default, use Vercel preview and tested rollbacks, and leave Smart Money publishing unchanged.
6. After any **authorized** deployment: independently verify payments, protected access, accurate member quotes, service/trading gates, and the BNB lifecycle; write the Empire Milestone Registry VPS checkpoint and independently read back `LATEST.json`, `LATEST.md`, history, record, and hashes.

**Current implementation status:** staged calculator only; not integrated into website or VPS. No billing authorization, no actual member migrations, no live-monitor process.

`MILESTONE_CHECKPOINT=NOT_YET_WRITTEN_TO_VPS`
