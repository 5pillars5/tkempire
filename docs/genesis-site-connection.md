# TK Empire: Genesis read-only website connection

This branch adds a status-only serverless endpoint at `/api/genesis/connection`, plus a dashboard badge. It does not change Genesis trading, approvals, execution controls, or production deployment.

## Gateway contract

A separately deployed authenticated HTTPS gateway must serve a **fresh, actual engine observation**:

```json
{"schema_version":1,"source":"genesis","observed_at":"2026-11-01T20:00:00Z","engine":{"mode":"PAPER","state":"RUNNING"}}
```

The timestamp above is an example, not a real report. The gateway must keep all trading commands, exchange credentials, order state, private MCP data and account information inaccessible. It should strictly filter fields, rate-limit access, authenticate each request, and prohibit caching. Refresh the heartbeat using actual observed state, never by re-timestamping old records.

Set server-only Vercel encrypted values `GENESIS_STATUS_URL` (the full HTTPS gateway URL) and `GENESIS_STATUS_TOKEN` (a dedicated long random **status-only** token). Never place credentials in the browser, GitHub, or public chat. Without these settings, the website says NOT VERIFIED.

The function times out after four seconds, refuses redirects, validates the response format, and considers heartbeats older than two minutes stale. It publishes only mode, state, and timestamp.

**Security limitation:** The existing Vercel configuration still contains older HTTP rewrites for `/api/health`, `/api/genesis/status`, weights and thoughts. This new endpoint does not protect or replace those routes. They must be reviewed and separately migrated to a scoped authenticated HTTPS gateway before production approval. Existing client-side PIN must not be treated as secure access control.

## Verification
Run `node --test tests/genesis-connection.test.js` on a local checkout. Test a Vercel preview with missing environment settings, then test with the real gateway after service review. Do not merge or promote without checking the legacy HTTP routes and page data provenance.
