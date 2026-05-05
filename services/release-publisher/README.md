# release-publisher

Decoupled worker that listens for `release.promoted` OASIS events and
propagates stable releases to:

- **App Store Connect** (iOS surface) — see `src/handlers/ios.ts` (R14)
- **Google Play Console** (Android surface) — see `src/handlers/android.ts` (R15)
- **Cloudflare edge cache** (web surface) — see `src/handlers/web.ts` (R16)

## Status

**Phase 5 — SCAFFOLD ONLY.** The worker subscribes to OASIS events, dispatches
to the right handler per surface, and has retry/dead-letter wiring. The actual
external API calls in `src/handlers/*` are stubs that throw `NOT_IMPLEMENTED`
with a clear credential requirement. Production wiring needs:

| Handler | Required env vars | Provisioning |
|---------|-------------------|--------------|
| iOS (R14) | `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY` (PEM) | App Store Connect API key with App Manager role |
| Android (R15) | `PLAY_CONSOLE_SERVICE_ACCOUNT_JSON` (full JSON) | Play Developer API access via service account |
| Web (R16) | `CLOUDFLARE_PURGE_TOKEN`, `CLOUDFLARE_ZONE_ID` | Scoped API token with Cache Purge permission |

## How it runs

Intended deployment: Cloud Run service polling Supabase Realtime on the
`oasis_events` channel filtered to `type=release.promoted`. On each event,
the handler is dispatched; failures are retried with exponential backoff
(max 5 retries) and dead-lettered as `release.publish.failed` events.

For Phase 5 scaffold, the worker prints what it would do and emits the
`release.publish.attempted` event so end-to-end traceability works.

## Run locally

```bash
cd services/release-publisher
npm install
SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... npm run dev
```

## Tickets

- R13: Worker scaffolding (this service)
- R14: iOS handler implementation (stub here)
- R15: Android handler implementation (stub here)
- R16: Web cache invalidation (stub here)
