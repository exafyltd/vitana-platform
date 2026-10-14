# VTID-05174 — acceptance (Health Hub Phase 0 / D5 remainder, PLAT-D5R)

Scope: the sparred plan's package PLAT-D5R (`plan-sparring.md`, Changes 5–7 and their Tests). V1-D4M (VTID-05173) and
V1-D5R (VTID-05175) are separate vitana-v1 PRs.

**What deploys:** gateway code. The new endpoint is inert until V1-D5R calls it (no caller exists before that), and on
staging it answers 409 without touching the database. **No migration, no flag.** The webhook log success row starts
carrying `user_id` on the next verified vendor webhook.

ROUTE_MOUNT: services/gateway/src/routes/health-erasure-internal.ts → router.post('/member-residue', requireServiceOrAdmin, …) (new); mounted in src/index.ts via mountRouterSync(app, '/api/v1/internal/health-erasure', healthErasureInternalRouter, { owner: 'health-erasure-internal' }) (once); claimed in orb/developer/domain-atlas.ts (health domain)
FINAL_URL: POST {gateway}/api/v1/internal/health-erasure/member-residue
CURL_PROOF: NOT run against staging or production — every authorised call is a POST that deletes rows in the database staging shares with production, and on staging it answers 409 by design. Expected on a local or test gateway only: `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST "$GATEWAY/api/v1/internal/health-erasure/member-residue"` → `401 application/json` (no token); with `VITANA_ENV=staging` and the service token → `409 {"ok":false,"error":"STAGING_READ_ONLY"}`. Proven in Jest (AC-1, AC-2, AC-8); staging checks only GET /alive and GET /api/v1/admin/build-info.
OASIS_PROOF: two new event types in CicdEventType, emitted per call: `health.erasure.vendor_revoke` (when the member has connections or the read fails; payload `connections_read`, `tokens_wiped`, `connectors[{connector_id,status}]`) and `health.erasure.member_residue` (always; payload `complete`, `webhook_log{deleted,residual,error}`, `partner_inbox{deleted,scrubbed,residual,error}`, `vendor_revoke_connectors`). No token, raw_payload, member id or provider id. Proven in Jest (AC-7, test "emits health.erasure.vendor_revoke and health.erasure.member_residue with ids/counts only").

AC-1 `POST /api/v1/internal/health-erasure/member-residue` is behind `requireServiceOrAdmin`: no token → 401, wrong
token → 401, member JWT → 403, service token or `exafy_admin` JWT → passes. A non-uuid `user_id` → 400
`INVALID_USER_ID` (also blocks PostgREST filter injection). No database client → 503 `DB_UNAVAILABLE`.
TEST: test/health-erasure-internal.test.ts "auth and input" — outputs/jest.txt

AC-2 Staging (`VITANA_ENV=staging`, the same detection as `wearable-features-bridge.ts` and A2's health-store flags)
→ 409 `{ ok:false, error:'STAGING_READ_ONLY' }` with no database call, no vendor call and no OASIS event.
TEST: "staging → 409 STAGING_READ_ONLY with no DB call"

AC-3 Part a: every `user_connections` row of the member is read once (before anything is erased), the token columns
are wiped with the same update `disconnectUserConnection` uses, and `revokeAtVendor` runs once per connector with that
connector's rows, 5 s each and 20 s in total (connectors past the cap → `skipped_timeout`). A vendor failure, throw or
wipe failure is reported and never changes `complete`. Tokens never reach the response, OASIS or the console.
TEST: "part a — vendor revoke" (5 tests)

AC-4 Part b: `connector_webhooks_log` rows are deleted where `user_id`, Terra `payload.user.reference_id` or Vital
`payload.client_user_id` equals the member, and where Terra `payload.user.user_id` / Vital `payload.user_id` is one of
the member's provider ids (scoped to that connector), read before any delete. The same filters are re-selected for
`residual`; residual > 0, a query error or an unreadable connection list → `complete:false`, error codes only.
TEST: "part b — webhook log" (6 tests)

AC-5 Part c: confirmed inbox rows of the member are deleted; `pending_member`/`declined` proposals are cleared
(`proposed_*`, `member_link_status`, `member_decided_at`); the id is removed from `candidate_user_ids` and
`member_declined_user_ids` by a plain read-then-write; the residual re-select (`proposed_user_id` or either array)
reports a simulated concurrent re-add as `complete:false`.
TEST: "part c — partner inbox" (4 tests)

AC-6 Response `{ ok, vendor_revoke, tokens_wiped, webhook_log, partner_inbox, complete }`, `complete` true only when both
residuals are numeric 0; a retry that finds nothing reports zeros (idempotent).
TEST: "happy path" (2 tests)

AC-7 OASIS `health.erasure.vendor_revoke` (connector ids + statuses) and `health.erasure.member_residue` (counts) are in
`CicdEventType`; their payloads contain no `raw_payload`, token, member id or provider id.
TEST: "OASIS" (2 tests)

AC-8 Mounted exactly once (`mountRouterSync(app, '/api/v1/internal/health-erasure', …, { owner: 'health-erasure-internal' })`)
and claimed in `domain-atlas.ts`; the VTID-04562 atlas drift guard stays green.
TEST: "mount and atlas"; `npm run test:roles` (105 passed)

AC-9 Change 6: the success log row in `connector-webhooks.ts` carries `user_id` when every normalized event of the
verified batch resolved to the same non-null member; mixed, partly unresolved and empty batches log NULL; the three
failure sites (unknown connector, handler error, invalid signature) never set it.
TEST: test/connector-webhooks-log-user-id.test.ts (9 tests)

AC-10 Change 7: STATUS.md row 4 → done with the five PRs; new row 20 for VTID-05173/05174/05175; deferred follow-ups
1–7 recorded.
TEST: review of `docs/programs/health-hub/STATUS.md`

AC-11 Existing suites green: vtid-05054 lab notice + webhook purge, admin-partner-health, partner-health-member,
partner-health/link-confirmation, vtid-05030 connection tokens (wearables disconnect), vtid-05025 commerce/health
boundary, vtid-04560 roles. `tsc --noEmit`: only the known local gaps (`libphonenumber-js`,
`@aws-sdk/client-pinpoint-sms-voice-v2` not installed in this checkout's node_modules), none in touched files.
TEST: outputs/jest.txt (9 suites, 309 tests), outputs/tsc.txt

## Staging verification

Read-only: `GET /api/v1/admin/build-info` (verified commit) and `GET /alive`. The endpoint is `kind: existing` (Jest):
every call is a POST that deletes data in the database staging shares with production, and on staging it answers 409
by design (`staging-tests.json`).

## Decisions taken (inside the approved plan)

1. Part a wipes the tokens before the vendor calls, not after — the same order as `POST /disconnect` (VTID-05030);
   the rows were already read, so the vendor call has what it needs, and local tokens are gone even if a vendor hangs.
2. Provider-id deletes are scoped to their connector (`connector_id = 'terra'` / `'vital'`), so another vendor's id
   that happens to match is never touched.
3. A failed `user_connections` read still runs the user-id deletes but reports `complete:false`
   (`CONNECTIONS_READ_FAILED`): rows keyed by provider ids cannot be ruled out without them.
4. OASIS payloads carry no member id at all (only connector ids, statuses, counts); the deletion request row is the
   audit record of who was erased.
5. The response carries an extra `tokens_wiped` field next to `vendor_revoke` (reported, never affects `complete`).
6. The domain-atlas claim is an explicit `/^health-erasure-internal/` in the health domain (the existing `/^health/`
   already matched; the explicit entry keeps the claim visible, as VTID-05055 did for `partner-health-member`).

## Gate 2 notes

- Report the read-only state of `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED` in the production task def; it is a
  precondition for V1-D5R's production deploy (sparring R1-F2).
- V1-D5R (VTID-05175) deploys only after this is live in production.
