# Imperian crypto-only portal — staged beta, no live collections

Date: 2026-11-13. Scope: TK Empire website preview + wallet signature authentication scaffold + settlement verification functions. This branch extends draft PR #53; do not merge until its base and all release holds are independently reviewed.

## Chosen rails

1. Native Circle USDC on Polygon PoS, chain ID 137, contract `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359`. Exact ERC-20 Transfer from member login wallet to *separate* Empire treasury. Audit chain ID, contract, destination, amount with token decimals, source, final receipt, 40 confirmations, log index and global unique payment reference. Direct transfers only in initial implementation.
2. Monero XMR through an independently installed, authenticated and isolated MoneroPay daemon. Create a fresh unique invoice subaddress per invoice using server-side POST /receive with required atomic amount. Read it back via authenticated GET /receive/:address and require complete/unlocked funds, at least 10 confirmations, and no observed double-spend flag. Never infer a Monero sender address; member login wallet and payment wallet may differ. Invoices and subaddress-to-member associations are private accounting records, not public pages.

[MoneroPay official API](https://moneropay.eu/api/receive.html). [Official native Polygon USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses).

**Privacy boundaries:** XMR shields ordinary onchain sender, receiver and amount but is not absolute anonymity. Member login wallet is visible to Empire; IPs, network traffic, browser logs, invoice associations and offchain service records may identify members. Do not publicly reveal wallet-to-invoice mappings. Users may pay XMR from a different wallet than their Ethereum identity; there is no detectable same-sender concept on Monero. The original signed EVM wallet remains membership identity regardless of payment rail.

## Policy

Each subscriber has one signed Ethereum wallet identity. On first independently confirmed subscription payment, store immutable `locked_max_rate_usdc` in a durable access-controlled database. Renewal quote always equals minimum of that rate and the *approved, durable* Genesis public pricing rate. Same benefits for every member; no upsells. Missing verified feeds cannot produce a new rate. The locked rate is an upper limit not a guarantee to continuously charge it. See `docs/imperian-price-protection-v1.md`.

## Current code and limitations

- `imperian.html` and `assets/js/imperian-portal.js`: responsive crypto-only portal with payment-choice preview, no payable addresses or active checkout buttons.
- `api/imperian/availability.js`: read-only public gate exposing both options as NOT READY and paid access OFF.
- `api/imperian/challenge.js`, `api/imperian/session.js`: staged stateless sign-in challenge and EOA EIP-191 signature verification using pinned ethers v6.15.0, HMAC session cookie. Requires `IMPERIAN_SESSION_SECRET` (64+ random characters) and explicit allowed host list `IMPERIAN_ALLOWED_HOSTS`, including staging host if testing; never print secrets. **This is NOT production-ready authentication**: durable single-use nonce consumption, CSRF semantics, auth/key rotation, EIP-1271 contract wallets, session invalidation, throttling, abuse controls and secure upstream identity are not yet provided. It grants NO entitlements, even when login succeeds.
- `lib/imperian-settlement.js`: pure validation functions; trusted RPC or MoneroPay origin not implemented. The pure validator trusts the upstream data supplied by its caller and cannot independently protect against forged receipts. Requires secured adapter and unique database constraint before processing.
- `lib/imperian-pricing-policy.js`: staged rule engine from PR #53. Price monitoring has no authorized durable state or production publisher.
- No `POST /checkout`, payment collection, automated invoices, subscriptions or refunds enabled. Do not deposit crypto into any address presented outside an independently verified finalized checkout.

## Production release blockers

1. **Security / entitlement:** protected transactional database with unique wallet identities, first-payment price lock, audit events, durable HMAC nonce, session invalidation, RBAC and signed membership lookup; payment completion and access granted only after database commit.
2. **USDC custody:** verify Empire treasury address by out-of-band operator approval; isolate from Genesis; pinned Polygon RPC and chain id; independent server validation with replay-proof transaction-reference DB uniqueness; reconciliation and failure reporting.
3. **XMR operations:** independently deployed MoneroPay service using view-only setup where possible; secured authentication and IP allowlisting; unique private subaddress per invoice; separate treasury control. Rate feed must be authoritative and fresh, quote expiration explicit, short payment/late payments reconciled manually, no arbitrary external callback trust.
4. **Subscription finance:** durable periodic renewal scheduler, proration and grace period policy, payment reminders, expiry, price audit, refunds and required business/AML/tax/sanctions compliance review. Privacy cannot imply noncompliance.
5. **Evidence:** authenticated Genesis financial reconciliation source, verified USD PnL with fees and risk, enough decisive trades and approved review interval. Keep trading runtime read-only.
6. **Release:** feature flags disabled by default; staging-only browser wallet QA, network/error tests, payment-provider integration tests, database concurrency and double-credit simulation, comprehensive CI, production and Smart Money/BNB health checks, formal operator sign-off.
7. **Archive:** after any authorized deployment and health verification, write milestone registry under `/root/tkempire/data/genesis/milestones/`; read back durable history, LATEST files, record and independent SHA-256. No VPS checkpoint is claimed from this GitHub staging alone.

No modifications to production VPS, real trades, Smart Money publisher, Vercel secrets or payment treasury were made here.

MILESTONE_CHECKPOINT=NOT_YET_WRITTEN_TO_VPS
