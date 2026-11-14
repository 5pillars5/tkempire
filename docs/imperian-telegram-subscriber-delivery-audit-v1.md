# Imperian Telegram Subscriber Delivery — Read-Only Audit & Mapping v1

Date: 2026-11-13 America/Chicago (observer at 2026-11-14 03:20 UTC)
Status: DRAFT — NOT SAFE TO ENABLE CUSTOMER DELIVERY
Scope: inspect existing source/runtime projection and design a restricted future subscriber path. No bot, trading, payment, production VPS or website actions authorized.

## Verified evidence and limitations

- READ_ONLY Empire observer: tkempire.service active/running (PID 2961027, NRestarts=0). Genesis projected ACTIVE. Event bus HEALTHY_WITH_REJECTIONS and 7 dead letters. Signal projection 200 total, 186 CLOSED, 14 OPEN, backlog 2, source attribution UNKNOWN for all 200. Risk WARNING: STALE_ACTIVE_TRADES:1. Latest signal timestamp 2026-11-13 15:01 UTC is substantially older than observer timestamp, yet age_seconds was ~19; the age metric's semantics require independent clarification. Do not treat a healthy projection as verified entry-event freshness.
- Public GitHub source options_bot.py: outbound Telegram sendMessage targets a private Telegram destination via TELEGRAM_PRIVATE_ID, with token read from environment. This file is not a membership bot and is NOT proof of currently deployed @tkempirebot privileges. Its raw HTTP error logger may include a token-bearing API URL. Confirm deployed process and remove unsafe logging before reusing any portion.
- Main website app.html/community.html links to https://t.me/tkempirebot, but links do not establish current permissions, webhook routing, admin rights or operator ACLs.
- Existing code ops/genesis-public-signals-v1/publisher.py builds paper-only GENESIS_PUBLIC_SIGNAL_PROJECTION. Public ID is HMAC of admission fingerprint with namespace genesis-public-v1. Stage PAPER_OPEN requires a canonical active record match; observed_at is original decision source time, not an explicit canonical OPENED timestamp. position_verification may be unverified.
- Existing ops/genesis-public-signals-v1/history_publisher.py builds separately canonical GENESIS_VERIFIED_PAPER_HISTORY_V1. Close ID is HMAC of trade_key with namespace genesis-paper-close-v1; it cannot be assumed to match opening IDs. PnL unit explicitly LEDGER_UNIT_UNVERIFIED, not dollars.
- Live Bot API getMe/getWebhookInfo/getMyCommands and runtime process command-ACL readback were NOT obtained. Requested private READ_ONLY task was POLICY_DENIED, and several observer service diagnostics failed closed. No live bot permissions have been certified.

## Permission decision

Keep operator bot credentials separate. Do NOT connect subscribers to existing operator/trade authorization, and do not mistake options_bot.py for the active bot identity. A dedicated future subscriber bot should only support private opt-in and read-only notifications; no group or channel admin authority, no trading commands, no VPS shell execution, no operator bot token and no private Genesis ledger file access. Verify all BotFather rights, webhook configuration and active runtime ACLs before enabling.

## Proposed Genesis v2 subscriber event contract — NOT DEPLOYED

Proposed authenticated exact route: GET /internal/genesis/subscriber-events
Producer: read-only canonical evidence projector on loopback, protected by separate authentication and an exact Nginx route; bound source identity and TLS; no redirects or write methods.

Schematic schema (not current live payload):

~~~json
{
  "schema_version": 2,
  "source": "GENESIS_VERIFIED_SUBSCRIBER_EVENTS_V2",
  "publication_scope": "SUBSCRIBER_APPROVED",
  "execution_authority": "none",
  "mode": "PAPER",
  "generated_at": "<UTC timestamp>",
  "events": [
    {
      "event_id": "<opaque HMAC event ID>",
      "lifecycle_id": "<opaque stable OPEN-to-CLOSE identifier>",
      "stage": "PAPER_OPEN",
      "stage_changed_at": "<canonical OPENED timestamp>",
      "decision_observed_at": "<decision timestamp>",
      "asset": "SOL",
      "side": "BUY",
      "position_evidence": "CANONICAL_PAPER_LEDGER"
    }
  ]
}
~~~

Requirements: event_id unique per canonical stage transition, consistent lifecycle_id from one-to-one admission fingerprint-to-trade_key mapping, same ID for open and close, stage_changed_at taken from verified OPENED/CLOSED ledger events. A single service must independently reconcile that mapping; subscriber code must never guess by matching coin/side/price or hashing two unrelated current published IDs. Generated payload must be fresh (<=120 seconds), complete, PAPER-only, exact source/scope, execution_authority none, with authenticated producer and allowed fields. Do not deliver stale historical alerts on worker startup without an approved explicit replay policy. A partial exit is NOT PAPER_CLOSED until canonical close evidence is present. Never disclose private fingerprint/trade_key, sizes, balances, order authorization, service paths, secrets, or unverified dollar PnL.

## Subscriber signup and delivery mapping

1. Member opens a dedicated subscriber bot and starts a private direct-message chat.
2. Existing authenticated website issues a cryptographically random one-time account-link token (<=64 Telegram base64url characters), expires in 10 minutes, stores only its digest and consumes it atomically. Telegram deep link carries the opaque token, not the wallet address or a crypto invoice.
3. Subscriber bot validates Telegram update identity via user.id and chat.type PRIVATE. It resolves the token through a private membership service; stores the stable Telegram user.id mapping, not the mutable username. Do not allow a customer-supplied chat_id in a send endpoint.
4. Free-beta delivery is gated by BETA_APPROVED; later paid delivery needs ACTIVE and independently verified paid-through status. Telegram commands must never grant entitlement or change the immutable original member price.
5. Separate read-only worker pulls the approved v2 event projection over authenticated HTTPS, refuses unverified/unknown/stale events, and creates a durable unique delivery record for each (event_id, telegram_user_id, template_version).
6. Send to a private opted-in member chat using Telegram sendMessage. On success, store Telegram message ID and acknowledgement; on 429 use limited retry/backoff; on block/opt-out/expiry stop sending. Mark unsent failures pending, never successful. No blind duplicate sends after a crash.
7. Format an OPEN message as GENESIS — PAPER OPEN / RESEARCH, with coin/side and canonical stage time, simulated-not-customer-traded disclosure. CLOSE as GENESIS — PAPER CLOSED / RESEARCH, same lifecycle ID, verified outcome and close time; never render LEDGER_UNIT_UNVERIFIED as USD. Do not issue action-like notifications from QUALIFIED/DETECTED/REJECTED/EXPIRED.
8. Smart Money wallet observations are separate from Genesis engine events and must be labeled separately; never synthesize trades from observations.
9. Alerts must contain no trading authority, no commands, no signing links. protect_content can reduce forwarding but is not a confidentiality guarantee.

Schematic path:

    Genesis canonical OPENED/CLOSED ledger (READ ONLY)
                         |
             Verified lifecycle projector v2
                         |
             Scoped authenticated HTTPS GET
                         |
             Subscriber evidence validator
                         |
        Membership / invite / paid-through lookup
                         |
        Durable per-member event delivery queue
                         |
             Dedicated Telegram subscriber bot
                         |
                Private user DM only

## Mandatory launch gates

- Independently read actual bot getMe, getWebhookInfo, getMyCommands (default and relevant scope), group/channel default administrator rights, and live process command/ACL routing without exposing tokens or webhook URLs. A Bot API command menu alone does not prove server-side authorization.
- Resolve source_counts UNKNOWN, 7 event-bus dead letters, the stale-active-trades warning and conflicting signal freshness semantics. Confirm canonical BNB partial and complete close one-to-one.
- Approve/prove v2 stable lifecycle correlation and canonical stage_changed_at against raw canonical evidence without exposing raw evidence to subscriber process.
- Prove subscriber process has no Genesis write ACL, no trade/execution keys, no operator token or shell execution; no shared bot credential.
- Test invite expiry/replay, duplicate Telegram ID, subscription expiry, fail-closed stale feed, unknown source, wrong stage, partial close, wrong PnL units, retries, delivery ACK, Telegram block, outages, duplicates, and 5–10 voluntary free beta member deliveries.
- Approve any live subscriber service separately, verify main service and Smart Money unchanged, and write/readback full VPS milestone registry with hashes.

## Exact milestone and next action

Current: IMPERIAN_TELEGRAM_AUDIT_AND_DELIVERY_MAPPING_STAGED_V1 — documentary and source audit; runtime bot ACL unknown; v2 read-only event contract proposed only.
Next stage: Independently verify live Telegram identity, scoped rights, webhook/polling, runtime command ACL, and canonical open/close event correlation.
Next action: Run a restricted non-secret read-only Telegram getMe/getMyCommands/getWebhookInfo audit on the VPS and inspect deployed bot service command routing; do not touch production controls.

MILESTONE_CHECKPOINT=NOT_YET_WRITTEN_TO_VPS
