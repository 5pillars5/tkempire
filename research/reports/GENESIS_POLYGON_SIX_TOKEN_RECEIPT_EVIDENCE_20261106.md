# Genesis Smart Money — Polygon ERC-1155 Receipt Retrieval (Read Only)

Date: 2026-11-06 UTC  
Scope: Six unresolved outcome-token cases in eight affected market conditions, fixed wallet cohort.  
Research execution: GitHub Actions #42298793231 (PASS) and #42298894401 (indexed provider probe failed with 403).  
No VPS access, trade authority, live trading or Genesis configuration changes.

## Verified receipt evidence

- Polygon PoS chain ID 137 confirmed via public JSON-RPC.
- `eth_getTransactionReceipt` successfully read 23 representative activity transactions drawn from the eight conditions.
- 1 remaining receipt query failed due external RPC access restrictions (HTTP 403/401).
- 302 CTF contract transfer logs observed across those 23 receipts, of which 193 were flagged as relevant to the wallet or selected market token IDs. Relevance is broad: a log may involve another trader using the same token; **do not count all 193 as wallet transfers**.
- Verified CTF ERC-1155 contract `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` by event address and transfer decoding.
- Transaction/log-level evidence captures `transactionHash + logIndex + from + to + tokenId + amount`, including `TransferSingle` and `TransferBatch`.
- The representative Papeasy redemption transactions contain explicit burns of both outcome tokens to the zero address, supporting prior redemption payout checks.
- Representative trade transactions show multi-hop clearinghouse/operator transfers and mint/split flows, explaining why **counting all token logs in a receipt double-counts inventory**. Only transitions directly across the monitored wallet boundary count for wallet balances.
- One sample transaction for wallet `0x06dc…4524` shows a batch token transfer from the wallet through clearinghouse contracts before final burns; transfers must be deduplicated at the wallet boundary.
- API-provided `REDEEM` events cannot be interpreted as newly purchased cost basis.
- No reliable full transfer timeline was recovered for the six unresolved token cases.

## Indexed wallet history source

Both monitored wallet queries attempted the public Polygon Blockscout v2 endpoint for ERC-1155 token transfers. `polygon.blockscout.com` returned **HTTP 403** in the CI environment. The legacy alternative `polygon.blockscout.io` was unreachable. Treat indexing as **unavailable**, not empty history.

## Independent P&L and fees

No additional position was promoted to independently verified economic P&L in this step.

Prior research remains valid at the limited scope:
- 14 prior mismatches reduced to six unverified opening inventory/cost-basis token cases after 10 MERGE events were handled.
- 8 of 8 redemption payout checks passed in previous research.
- Two provisional closed-market P&L matches for `0x06dc…4524` with differences of $0.1186 and $0.0657.

**Fee verification is still incomplete.** The sampled Polygon receipts do not prove maker/taker fees and net USDC settlement for every wallet fill. Transaction gas fees are distinct from venue trading fees; don't subtract the whole transaction's gas from a wallet if another address submitted the transaction.

## Exact blockers and next safe action

1. Obtain a reliable indexed Polygon ERC-1155 transfer history (e.g. authenticated explorer API, indexed data export, or rate-limit-safe `eth_getLogs` from a trusted RPC archive/indexer) scoped to the exact two wallets and six token IDs.
2. Retrieve *all* relevant token transfer logs, including early opening mint, deposits and migrations, not merely transactions already present in the Polymarket activity feed.
3. Filter wallet-boundary token inflows/outflows by wallet address, token ID and exact `txHash:logIndex`; handle zero-address mints/burns and intermediate clearing addresses without attributing their movements to the wallet.
4. Obtain trade fill price, fee schedule, realized fee records and USDC transfers; allocate shared paired-token conversion costs only once.
5. Reconcile balances at one snapshot block height, re-run economic P&L comparisons with fee tolerance, and only then consider wallet quality scores.

## Status

- `POLYGON_RPC_RECEIPT_PROBE=PASS_WITH_GAPS`
- `ONCHAIN_COMPLETE_TOKEN_HISTORY=NOT_VERIFIED`
- `OPENING_COST_BASIS=UNRESOLVED_SIX_TOKENS`
- `FEE_RECONCILIATION=PENDING`
- `INDEPENDENT_WALLET_QUALITY_SCORES=WITHHELD`
- `MILESTONE_CHECKPOINT=NOT_YET_WRITTEN_TO_VPS`

Previous verified VPS checkpoint: `20261106T195838Z_genesis_smart_money_monitor_v1_persistent_readonly_verified`. This research does not modify the Empire Milestone Registry.
