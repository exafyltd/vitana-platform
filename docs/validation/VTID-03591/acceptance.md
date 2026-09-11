# VTID-03591 — merge/CI-fix increment (continued under VTID-03702)

Evidence pack for the commits pushed to this PR on 2026-08-23 that merge
`origin/main` (141 commits, including the GCP decommission and other
in-flight Aurora/DB-i18n work) into this branch and fix the resulting CI
breakage. This is a mechanical merge-hygiene pass, not new Aurora-client
functionality — the pre-existing `aurora-client.ts`/RLS-shim work in the
rest of this PR is unchanged by these commits.

Continuation tracked under **VTID-03702** (the standing "full Supabase→AWS/
Aurora migration, including Auth" effort) — evidence filed under VTID-03591
because the Evidence Pack Gate keys strictly off the PR title's VTID.

---

AC-1 — Merging 141 commits from `origin/main` does not silently drop or
corrupt this branch's own Aurora work

The merge resolved two real conflicts (`services/gateway/package.json`,
`services/gateway/package-lock.json` — both dependency-version conflicts,
additive on both sides) and nothing else; git reported no other conflicted
paths.

TEST: `git log --oneline ca00ed8..d9814f3` — every commit from both
branches is present in the merged history, none dropped.
Output: `outputs/merge-commits.txt` (145 commits)

AC-2 — `services/gateway/package.json` resolves cleanly with no leftover
conflict markers and no version regression

Both branches' additions are kept: `@aws-sdk/client-s3` and
`@aws-sdk/client-transcribe-streaming` (added by `main`), `pg@^8.23.0` and
`@types/pg@^8.21.0` (this branch's versions, newer than `main`'s
`8.22.0`/`8.20.4`).

TEST: `grep -n "^<<<<<<<\|^=======\|^>>>>>>>" services/gateway/package.json`
returns nothing.

AC-3 — `services/gateway/pnpm-lock.yaml` matches the resolved `package.json`

That's the lockfile CI's `pnpm install --frozen-lockfile` actually reads
(`TEST-SUITE.yml`'s `working-directory: services/gateway`). The first fix
attempt regenerated the wrong one (`package-lock.json` via `npm`) and CI
kept failing with `ERR_PNPM_OUTDATED_LOCKFILE`. Regenerated with pnpm 9.0.0
(matching `packageManager`/CI's pin) so the format matches CI exactly.

TEST: `cd services/gateway && pnpm install --frozen-lockfile` exits 0.
Output: `outputs/pnpm-frozen-lockfile-check.txt`

AC-4 — The Dev Autopilot Impact Scan warning (undocumented
`AURORA_DATABASE_URL`/`AURORA_SSL`/`AURORA_POOL_MAX`) is closed without
changing `aurora-client.ts`'s behavior

`getAuroraPool()` still returns `null` until `AURORA_DATABASE_URL` is set —
this is a `.env.example` documentation addition only, same deliberate-opt-in
shape as `TTS_PROVIDER`/`IMAGE_PROVIDER`/`BEDROCK_ROLE_ARN`.

TEST: `grep -A12 "Aurora application-layer client" services/gateway/.env.example`
Output: `outputs/env-example-aurora-section.txt`

---

OASIS_IMPACT: no — this increment is CI/lockfile hygiene and documentation
only; `getAuroraPool()` remains unwired and unconfigured, no runtime
behavior changes, so there is no state transition for OASIS to record.

---

# Aurora migration B7 — AI Bridge route (VTID-03764 chain)

Filed under this VTID because the Evidence Pack Gate keys off the PR
title's VTID, same reason as the section above — this is a separate,
later increment on the same PR (Aurora migration B7: closing the
"23-of-74 edge functions call Gemini/Vertex directly" violation named in
`docs/AURORA-B7-EDGE-FUNCTIONS-INVENTORY.md`), not new Aurora-identity
work.

AC-5 — A new gateway route exists for the Bedrock bridge, correctly
auth-gated, and is mounted where the route-mount evidence gate expects

ROUTE_MOUNT: `services/gateway/src/routes/ai-bridge.ts` → `router.post('/generate', requireServiceOrAdmin, ...)`; mounted in `services/gateway/src/index.ts` via `mountRouterSync(app, '/api/v1/ai-bridge', aiBridgeRouter, { owner: 'ai-bridge' })`.
FINAL_URL: `POST {gateway}/api/v1/ai-bridge/generate`
CURL_PROOF: this is a service-to-service route (Supabase edge functions → gateway), never called by an end user, so there is no production traffic to point at pre-merge — same shape as VTID-03605's FHIR callback evidence above ("after merge-to-main auto-deploys staging"). Once staging picks up this commit: `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-aws-gateway.vitanaland.com/api/v1/ai-bridge/generate -H "Content-Type: application/json" -d '{}'` must return `401 application/json...` (`{"ok":false,"error":"missing bearer token"}` — auth required, route exists), NOT `404 text/html`. With a valid `GATEWAY_SERVICE_TOKEN` bearer and an empty `messages` array, the same endpoint must return `400 application/json` (`{"ok":false,"error":"messages must be a non-empty array"}`), confirming request validation runs past the auth gate. Local equivalent, run this session (not a substitute for the staging check above, but confirms the route exists and both gates fire before any deploy): `services/gateway/test/ai-bridge.test.ts` boots the router directly via `express()`+`supertest` and asserts exactly these two response shapes (10/10 passing — see the Test Suite Summary check on this PR's own CI run).

AC-6 — The route makes no DB write and has no state transition to record

`invokeBedrock()` (existing, unmodified — `services/gateway/src/providers/bedrock.ts`) makes a single stateless call to Bedrock and returns its response; nothing is written to Supabase/Aurora, no OASIS-worthy decision is made. Marked `// impact-allow-no-oasis` in the handler body, same category as VTID-03605's FHIR-authorize leg noted above ("only runs discovery and returns a URL, no state change").

TEST: `services/gateway/test/ai-bridge.test.ts` — 10 tests covering auth gating (401 with no token, JWT path never touched when the service token matches), request-shape validation (400s), Gemini→Bedrock request translation (system-turn splitting, tool-schema translation, option forwarding/defaulting), and Bedrock→Gemini response translation (text and functionCall shapes) plus a `not_configured` error surfaced as 502.

OASIS_IMPACT: no — see AC-6.

---

## Addendum, 2026-09-10 (VTID-03815 continuation) — the `/transcribe` leg (B7's `transcribe-audio`)

Evidence filed here for the same reason the 2026-08-23 increment above was:
the Evidence Pack Gate keys strictly off the PR title's VTID (VTID-03591),
and this is a later increment on the same PR, not new Aurora-identity work.

AC-7 — A new gateway route exists for the Amazon Transcribe bridge,
correctly auth-gated, and is mounted where the route-mount evidence gate
expects

ROUTE_MOUNT: `services/gateway/src/routes/ai-bridge.ts` → `router.post('/transcribe', requireServiceOrAdmin, ...)`; mounted the same way AC-5's `/generate` is, via `mountRouterSync(app, '/api/v1/ai-bridge', aiBridgeRouter, { owner: 'ai-bridge' })` in `services/gateway/src/index.ts` (no separate mount call needed — same router instance).
FINAL_URL: `POST {gateway}/api/v1/ai-bridge/transcribe`
CURL_PROOF: same shape as AC-5's `/generate` — a service-to-service route (Supabase edge function → gateway) never called by an end user, so there is no production traffic to point at pre-merge, and this branch has never been merged to `main` (`AWS-STAGE-DEPLOY-GATEWAY.yml` only auto-deploys staging on push to `main`), so there is no live URL this session can curl at all yet — stated plainly rather than inventing a result, per this gate's own stated purpose (VTID-03696: "a gate that can only be passed by making something up launders a guess into a green check, which is worse than not having the gate"). Once staging picks up this commit: `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-aws-gateway.vitanaland.com/api/v1/ai-bridge/transcribe -H "Content-Type: application/json" -d '{}'` must return `401 application/json...` (auth required, route exists), NOT `404 text/html`. With a valid `GATEWAY_SERVICE_TOKEN` bearer and no `audioBase64`, the same endpoint must return `400 application/json` (`{"ok":false,"error":"audioBase64 must be a non-empty string"}`), confirming request validation runs past the auth gate. Local equivalent, run this session (not a substitute for the staging check above, but confirms the route exists and both gates fire before any deploy): `services/gateway/test/ai-bridge.test.ts`'s `POST /api/v1/ai-bridge/transcribe` block boots the router directly via `express()`+`supertest` and asserts exactly these two response shapes (8/8 passing).

AC-8 — The route makes no DB write and has no state transition to record

`transcribeAudioClip()` (`services/gateway/src/services/transcribe-audio-bridge.ts`) decodes the audio via a local `ffmpeg` subprocess and makes a single stateless call to Amazon Transcribe streaming, returning the transcript; nothing is written to Supabase/Aurora, no OASIS-worthy decision is made. Marked `// impact-allow-no-oasis` in the handler body, same category as AC-6.

TEST: `services/gateway/test/ai-bridge.test.ts` — 8 new tests covering auth gating (401 with no token), request-shape validation (400s for missing/invalid `audioBase64`/`language`), base64 decode + forwarding of bytes/language/mimeType to the bridge, the success response shape, and error mapping (`UNSUPPORTED_LANGUAGE` → 422, any other thrown error → 502). Full gateway suite re-run after this addition: 835/836 suites (1 pre-existing skip), 14,319 tests passing, 0 failures; `tsc --noEmit` clean.

**Not independently confirmed against live traffic** — same honest caveat as most of this PR's own changelog: the next real signal is a staging deploy actually exercising the ffmpeg-decode + Transcribe-streaming path end-to-end (this sandbox has no `ffmpeg` binary and no AWS Transcribe network access to test that leg directly).

OASIS_IMPACT: no — see AC-8.

---

## Addendum, 2026-09-11 (VTID-03815 continuation) — B5 execution: `user_notifications` polling relay

Evidence filed here for the same reason as the two increments above: the
Evidence Pack Gate keys strictly off the PR title's VTID (VTID-03591), and
this is a later increment on the same PR (Aurora migration B5 execution,
per `docs/AURORA-B5-REALTIME-INVENTORY.md`'s 2026-09-11 addendum), not new
Aurora-identity work.

AC-9 — A new gateway route exists for the B5 realtime relay, correctly
auth-gated, feature-flagged off, and is mounted where the route-mount
evidence gate expects

ROUTE_MOUNT: `services/gateway/src/routes/realtime-relay.ts` → `router.get('/user-notifications/stream', requireAuth, requireTenant, ...)`; mounted via a new `mountRouterSync(app, '/api/v1/realtime', realtimeRelayRouter, { owner: 'realtime-relay' })` call added to `services/gateway/src/index.ts`.
FINAL_URL: `GET {gateway}/api/v1/realtime/user-notifications/stream`
CURL_PROOF: this branch has never been merged to `main`, so there is no live staging URL to curl yet — same honest gap AC-7 above states plainly rather than inventing a result. Once staging picks up this commit, with the feature flag left at its default (`FEATURE_REALTIME_RELAY_USER_NOTIFICATIONS_ENV` unset): `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/realtime/user-notifications/stream -H "Authorization: Bearer <valid-jwt>"` must return `404 application/json` (`{"ok":false,"error":"not_enabled"}` — route exists and is correctly gated off, not missing) — this is deliberately the expected passing result, since the flag ships off by design. With no `Authorization` header at all, the same URL must return `401` (auth checked before the flag, confirmed by `realtime-relay.test.ts`'s second test asserting `isFeatureLive` is not the only gate — actually per the route's own ordering the flag check runs first; either 401 or 404 is a route-exists signal, `404 text/html` from Express's own catch-all is the only failure shape). Local equivalent, run this session: `services/gateway/test/routes/realtime-relay.test.ts` boots the router directly via `express()`+`supertest` and asserts the flag-off 404 shape and that `isFeatureLive('REALTIME_RELAY_USER_NOTIFICATIONS')` is checked (2/2 passing).

AC-10 — The route makes no DB write and has no state transition to record

The route only reads rows the caller already owns (`user_id`/`tenant_id` match, same scoping as the existing `GET /notifications` endpoint) via `startNotificationPolling()`/`fetchNotificationsSinceCursor()` (`services/gateway/src/services/realtime/`); nothing is written to Supabase/Aurora, no OASIS-worthy decision is made. Marked `// impact-allow-no-oasis` in the handler body, same category as AC-6/AC-8 above.

TEST: `services/gateway/test/services/realtime/user-notifications-relay-repository.test.ts` (4 tests — query scoping, cursor filter shape with/without a tie-break id, ordering/limit) and `services/gateway/test/services/realtime/user-notifications-poller.test.ts` (6 tests — cursor advance on success, cursor held on error, `onRows`/`onError` callback wiring, interval start/stop lifecycle) plus `services/gateway/test/routes/realtime-relay.test.ts` (2 tests, AC-9). Full gateway suite re-run after this addition: 838/839 suites (1 pre-existing skip), 14,331 tests passing, 0 failures; `tsc --noEmit` clean.

**Not independently confirmed against live traffic** — same honest caveat as every increment in this PR: this session has no live Supabase/Aurora credentials to exercise a real poll cycle end-to-end. The feature flag ships off specifically so this gap doesn't matter until someone deliberately flips it after confirming the route on staging first.

OASIS_IMPACT: no — see AC-10.

---

## Addendum, 2026-09-11 continued — `user_activity_log` relay added; AC-10's cited test files renamed by a same-day refactor

**Correction to AC-10 above:** its `TEST:` line cites
`user-notifications-relay-repository.test.ts` and
`user-notifications-poller.test.ts` by name. Both files were deleted the
same day, in the very next commit on this PR — their logic was
generalized into `generic-cursor-relay.ts`/`generic-cursor-relay.test.ts`
once a second table (`user_activity_log`) needed the identical
cursor/polling logic (see `AURORA-B5-REALTIME-INVENTORY.md`'s matching
addendum for why this was a refactor, not a second hand-copy). AC-10's
own behavioral claims (no DB write, read-only, `impact-allow-no-oasis`)
are unaffected and still hold — only the specific file names it cites are
now stale. Not rewriting AC-9/AC-10 in place, to keep this evidence pack's
own history intact; recorded here instead, the same correction-by-addendum
pattern this PR already used for the `AURORA_DATABASE_URL`→
`AURORA_RLS_DATABASE_URL` rename.

AC-11 — A second new gateway route exists for `user_activity_log`,
correctly auth-gated, feature-flagged off, sharing the same route-mount
call as AC-9

ROUTE_MOUNT: `services/gateway/src/routes/realtime-relay.ts` → `router.get('/user-activity-log/stream', requireAuth, requireTenant, ...)`; same `mountRouterSync(app, '/api/v1/realtime', realtimeRelayRouter, ...)` call as AC-9 (one router, two routes — no separate mount needed).
FINAL_URL: `GET {gateway}/api/v1/realtime/user-activity-log/stream`
CURL_PROOF: same shape and same honest gap as AC-9 — this branch has never merged to `main`, no live staging URL exists to curl yet. Once staging picks it up, with `FEATURE_REALTIME_RELAY_USER_ACTIVITY_LOG_ENV` left unset: `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/realtime/user-activity-log/stream -H "Authorization: Bearer <valid-jwt>"` must return `404 application/json` (`{"ok":false,"error":"not_enabled"}`) — the expected passing result, flag ships off by design. Local equivalent run this session: `services/gateway/test/routes/realtime-relay.test.ts`'s parameterized `describe.each` block covers this path identically to AC-9's (2/2 passing for this route).

AC-12 — The `user_activity_log` route makes no DB write and has no state transition to record

Read-only, same posture as AC-10 — `user_activity_log` has no `tenant_id` column at all (confirmed against both `user-context-profiler-repository.ts`'s `fetchActivityLogRows()` read side and `timeline-projector.ts`'s `writeTimelineRow()` write side), so this route's `RelayTableConfig.filters` is `{ user_id }` only, no tenant scoping to get wrong. Marked `// impact-allow-no-oasis` in the shared `streamTable()` handler factory, covering both AC-9's and this route.

TEST: `services/gateway/test/services/realtime/generic-cursor-relay.test.ts` (12 tests — query scoping including the `is(col, null)` branch, cursor filter shape with/without a tie-break id, ordering/limit, poll cursor-advance/error/stop semantics) and `services/gateway/test/routes/realtime-relay.test.ts`'s parameterized suite (4 tests total, 2 per route). Full gateway suite re-run: 837/838 suites (1 pre-existing skip), 14,335 tests passing, 0 failures; `tsc --noEmit` clean.

**Not independently confirmed against live traffic** — same caveat as AC-9/AC-10, unchanged by this addition.

OASIS_IMPACT: no — see AC-12.
