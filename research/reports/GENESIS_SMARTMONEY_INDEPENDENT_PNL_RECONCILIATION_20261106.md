# Genesis Smart Money — Independent P&L Reconciliation Evidence

Date: 2026-11-06 UTC  
Scope: eight formerly mismatched market conditions / fourteen outcome-token cases, drawn from the same fixed eight-wallet research cohort.  
Research execution: GitHub Actions run 42297305764 (successful); job 128165779800.  
Checkpoint: **research-only**, not a Genesis live-trading or milestone-registry change.  
Wallet scores: **WITHHELD**.

## Quantitative readback

| Metric | Verified count |
|---|---:|
| Markets retrieved | 8 of 8 |
| Outcome-token cases | 14 |
| Inventories reconciled after MERGE attribution | 8 |
| Unreconciled inventories | 6 |
| Read-only public activity rows | 579 |
| Distinct valid identities | 579 |
| Duplicate or invalid identities | 0 |
| Blank-token MERGE events correctly mapped to paired outcomes | 10 |
| Verified redemption payout amounts | 8 of 8 |
| Explicit CTF-vector markets | 2 |
| Oracle-price-derived binary outcome vector markets | 2 |
| Market cash-flow P&L matches within tolerance | 2 |
| Independently verified on-chain end-to-end P&L | 0 |

**Independent P&L comparator:** Source-provided trade and redemption amounts, plus once-counted paired MERGE collateral, minus observed buy amounts; compared against separately queried CLOSED position `realized_pnl`. This is independently **calculated**, not sourced from an independent on-chain indexer. Fees, transfers and external inflows remain possible confounders.

## Provisional full-market P&L matches

- Wallet `0x06dc51826bc524d9a83770e7de9dd7e005b04524`, condition `0xa28b5f443744069cdb4e4f47aadb6bfcfb8a3614da98b994bea152d231274074`: CLOSED position P&L **-$3,985.1433**, modeled market cash P&L **-$3,985.2619**, delta **-$0.1186**. All outcome token balances reconciled after structural merges. Oracle-price-derived binary payout checks passed.
- Same wallet, condition `0xcfe3135ee8946574a475c692da62810f60ad56d64c919c524a975818120d38c7`: CLOSED position P&L **-$1,433.8320**, modeled market cash P&L **-$1,433.8977**, delta **-$0.0657**. Both token balances reconciled. Oracle-derived payout checks passed.

These two checks are **PROVISIONAL_MARKET_PNL_MATCH**, not independently on-chain audited trades. Do not promote to scored live recommendations.

## Other six market cases

- Papeasy, two rapid-expiry Bitcoin markets, four outcome tokens: final payout redemptions matched explicit CTF vectors but redeemed quantities exceeded buys observed in the public activity history. Missing opening inventory/cost basis. Market P&L not validated.
- justdance, two Bitcoin November threshold markets, four outcome tokens: all four token inventories reconciled when paired MERGE events were included. Markets have concurrent closed/held positions; market-wide net cash cannot safely be equated with realized P&L. Market P&L not validated.
- Spirit of Ukraine>UMA, two markets, two outcome tokens: sells without matching earlier buys / opening basis in the retrieved activity; inventory and P&L remain unreconciled.

## Required next evidence

1. On-chain ERC-1155 TransferSingle/TransferBatch records and exact log identities (transaction hash **plus** log index), filtered by wallet, condition and token, to resolve missing initial inventory.
2. Contract-level PositionSplit, PositionsMerge, PayoutRedemption and appropriate negative-risk conversion events; reconcile paired burns and collateral movements **once**.
3. CTF/exchange fills, cost-basis allocations, taker/maker fees and USDC transfers to reconcile economic P&L.
4. Align source snapshots at one block height; avoid comparing moving OPEN/CLOSED views without a common cutoff.
5. Only then expand beyond eight markets and compute score-eligible wallet metrics. Keep PAPER, maintenance and exchange execution disabled.

## Preservation

Read-only GitHub research; no changes to `/root/tkempire`, `tkempire.service`, Genesis PAPER positions, collector timer, or Empire Milestone Registry. No VPS checkpoint written for this research. Last previously verified registry checkpoint remains `20261106T195838Z_genesis_smart_money_monitor_v1_persistent_readonly_verified`.
