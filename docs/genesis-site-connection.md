# TK Empire / Genesis status-only HTTPS gateway

Status: development branch, not production. This does not modify engine execution, approvals, timers, or trading state.

## Confirmed source fields
The canonical VPS `/health` endpoint returns top-level `served_at` and `engine` with `running` and `mode`. Its actual field types still require validation. The new Vercel endpoint maps the source response to an allowlisted mode, engine state and freshness timestamp, but does **not** establish independent evidence of actual trading.

## Proposed routing
- DNS `api.tkempire.io` will be a dedicated `A` record to the approved VPS only after checking existing ownership and host routing.
- VPS Nginx will terminate certificate-validated HTTPS for `api.tkempire.io` on port 443.
- A restricted Nginx location `/internal/genesis/health` must require HTTP Basic authentication and proxy solely to `http://127.0.0.1:5000/health`. Deny directory listings, every other path, redirects and all mutation methods. Set `Cache-Control: no-store`.
- Store a long unique password hash in root-owned Nginx htpasswd file outside source control. Store the plaintext only in the Vercel encrypted server-side `GENESIS_STATUS_TOKEN`. Use username `tkempire-site`. Never paste it into chat, GitHub, or terminal output.
- Configure encrypted Vercel server variables: `GENESIS_STATUS_URL=https://api.tkempire.io/internal/genesis/health` and `GENESIS_STATUS_TOKEN`.
- Browser fetches only `/api/genesis/connection`. The response returns no internal trades, balances, risk config, secrets or raw logs.

## Validation and deployment
1. Check timestamp format and actual mode values on `/health`, without printing sensitive records.
2. Stage separate Nginx HTTPS site and TLS certificate, and validate `nginx -t` before reloading.
3. Validate unauthenticated gateway returns 401, approved gateway returns 200 with correct authentication, certificates valid, stale data fails closed, and Vercel preview resolves the new endpoint.
4. **Important:** Existing public website Vercel routes still rewrite `/api/health`, `/api/genesis/status`, thoughts and weights to the public unencrypted VPS port 5000. New connection badge does not secure those routes.
5. Migrate legacy website/API routes to a deliberate scoped HTTPS mechanism; audit content for private data; then restrict external TCP 5000 and bind internal service to loopback where possible. Do not cut over until the new endpoint and rollback path are confirmed.
6. Run `node --test tests/genesis-connection.test.js` on an actual checkout; preview build success alone does not verify tests.
7. Do not merge/ship to production until security review and end-to-end verification.

**Do not assume status API availability means paper trading is executing, or that a refreshed served_at means underlying trade state was refreshed.**
