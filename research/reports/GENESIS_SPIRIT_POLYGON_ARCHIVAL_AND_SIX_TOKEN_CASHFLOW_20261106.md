# Genesis Smart Money: Polygon archival transfer and fee-adjusted USDC evidence

**Research date:** 2026-11-06 UTC  
**Mode:** Read-only public blockchain research; no VPS/Genesis access and no trading orders.  
**Status:** Partial archival coverage. Independent full fee-adjusted P&L is **NOT VERIFIED** for the six specified token cases.

## Fixed six-token cohort

- Four Papeasy CTF outcome tokens in two resolved, short-duration Bitcoin markets, conditions `0x197b6683dfa66ae2721066584357219ab8f4154b7b4574fa678e334a7f54b33b0` [CHECK: use canonical `0x197b6683dfa66ae2721066584357219ab8f4154b7b4574fa7db7a00fc40fd9fe`] and `0xe5e31527a8c0e9b7edeadb69acb2a31bbf751e2c3ec10c88e2517f9237b239`. The bracketed incorrect control condition above was only a rejected indexed-provider probe identifier and **is not canonical**.
- Two Spirit of Ukraine>UMA tokens in conditions `0x998bc71817b2d76921d1999ce0f3431cfd5945583667a371280ca2b430b0c06e` and `0xe50c71cc5e2372bf0f6194a02e51459dd03b2c7b2d78a0d4650e5f36c425338b`.

## Historical indexing provider verification

Routescan's published supported-chains directory does **not** include Polygon/chain 137. Its Polygon `erc1155-transfers` requests returned HTTP 400, because the chain is unsupported; do not retry or treat this as empty history. This finding is now explicitly noted in the CI research workflow.

The Polygon Blockscout ERC-1155 indexed API returned HTTP 403 for these wallets in this CI environment. A complete indexed-token ledger was therefore **not obtained** from public unauthenticated explorer access.

Four alternative public Polygon JSON-RPC endpoints were tested with two fixed Spirit transaction hashes that the earlier PublicNode request had blocked:
- dRPC Polygon: correct chain 137 and **2/2** matching historical transaction receipts.
- ZAN Polygon: correct chain 137 and **2/2** matching historical transaction receipts.
- QuikNode public Polygon: correct chain 137 and **2/2** matching historical transaction receipts.
- SwiftNodes public Polygon: correct chain 137 and **1/2** matching receipts, one HTTP 429.

Both receipts that passed were independently resolved to Polygon blocks `93931960` and `94087818` with matching on-chain CTF contract logs and wallet topics. These are **historical receipt lookups**, not complete indexed ERC-1155 wallet transfer histories.

## Spirit history anchor

A wallet-boundary `eth_getLogs` scan over Polygon blocks `96643316–96651316`, anchored to the public position's first-entry timestamp `1793676430`, recovered **91,661.2766 incoming outcome shares** into Spirit's wallet for condition `0x998bc718...`, token ID `6302359956133594764084277082169634158291609371270652093164054687145970756151`.

Position snapshot in that read: current size **3,266.0816**, status `REDEEMABLE`. The 8,001-block scan does not cover later sells/settlement or guarantee no earlier token transfer. No opening purchase cost was independently established from that token inflow.

An older-history scan for condition `0xe50c71cc...` (historical 2025 first entry) was blocked: PublicNode returned HTTP 403, and a later dRPC broad `eth_getLogs` scan returned HTTP 400. **Older Spirit history and complete opening inventory remain unresolved.**

## Papeasy ERC-1155 and collateral checks

Previously verified four-token inventory readback from Polygon block interval `96861000–96863000`: 315 distinct wallet-boundary CTF `TransferSingle`/`TransferBatch` log identities; each of the four selected tokens had received quantity equal to redeemed/burned quantity, leaving net zero over the interval.

A second scan of CTF and collateral `0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb` ERC-20 transfers within that same block window found **572** distinct wallet-boundary logs in **358** transaction hashes. In transactions with only one selected market's *wallet-visible* tokens:
- 3:50–3:55 PM ET Bitcoin market: 44 exclusive token transaction hashes, **324.949227** collateral units debited, 0 credited, with 12 token transactions having no matching collateral wallet transfer.
- 3:45–3:50 PM ET Bitcoin market: 58 exclusive token transaction hashes, **345.068980** collateral units debited, 0 credited, with 12 token transactions having no matching collateral wallet transfer.
- Other collateral-only transactions were excluded; **do not assume those transactions are unrelated market cash flows**. The exclusivity check only covers wallet-level token IDs, not all internal transactions or other contract movements.

Direct Polygon receipt readback for both final Papeasy redemption transaction hashes showed the correct ERC-1155 burns but **no ERC-20 `Transfer` directly to the monitored wallet** in either receipt. The API's redemption proceeds therefore cannot be independently reconciled by counting only this wallet's ERC-20 token transfer events. This does **not** prove there was no economic credit; an internal or alternative settlement path may apply.

Prior API CLOSED-position P&L for the two resolved markets: **+$16.0755** and **-$85.2892** respectively. The earlier gross event-based figures (+$3,059.16 and +$5,272.19) excluded material acquisition/settlement economics and are **not valid profit estimates**. The new observed debit quantities also cannot be subtracted from redemption amounts to obtain verified profit.

## Fees and full P&L status

- No complete attributed inventory cost basis for the two Spirit tokens.
- No complete venue-specific trading fee ledger, actual settlement receipts, cost-basis allocation across paired positions or internal ledger settlement for the four Papeasy tokens.
- Polygon receipt `gasUsed` and `effectiveGasPrice` exist, but transaction gas costs **cannot be attributed to a wallet that was not the transaction sender** merely because its tokens were involved in the transaction. Relayed trades need separate attribution.
- No new fully independently verified *fee-adjusted* P&L claims for any of the six token cases.
- Earlier two provisional `0x06dc...` market P&L matches are separate research cases, not part of the six.

## Next required evidence

1. Use an authenticated **Polygon-supported indexer** (Etherscan V2/PolygonScan chainid=137 `account.token1155tx`, an equivalent paid/free archival index, or managed indexed export) to enumerate *complete* wallet-level ERC-1155 transfers for each of Spirit's two token IDs, including long-range activity back into 2025. Verify `transactionHash + logIndex`, opening transfer quantity and continuous block coverage; reject truncated history.
2. Retrieve transaction-level ERC-20 collateral movements and exchange execution events for every relevant purchase, sale, split, merge and redemption, including internal clearinghouse movements and proper economic attribution.
3. Recover maker/taker fee charges, rebates, native gas borne by the wallet (if any) and settlement account adjustments. Avoid using an assumed constant fee or treating all gas as wallet expense.
4. Reconcile six cases at a fixed chain block and explicit cutoff, calculate independent net P&L and compare to Polymarket positions with documented tolerance.
5. Only after exhaustive evidence consider ranking wallet quality. Until then, **WALLET_QUALITY_SCORES=WITHHELD**.

## Verification and provenance

- GitHub Actions: `42301396378` (Routescan unsupported), `42301585392` (Papeasy collateral), `42301902735` (alternative historic RPC receipts), `42302075314` (dRPC broad log scan rejection), `42302156805` (redemption collateral log check). Additional dated CI research runs contain replays and syntax checks.
- No Empire VPS files, production Genesis configuration or active-paper-trade state changed.
- Prior verified VPS checkpoint remains `20261106T195838Z_genesis_smart_money_monitor_v1_persistent_readonly_verified`.
- **MILESTONE_CHECKPOINT=NOT_YET_WRITTEN_TO_VPS** for this research.
