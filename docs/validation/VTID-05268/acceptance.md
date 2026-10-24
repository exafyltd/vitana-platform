# VTID-05268 — mt-jobs/jobs-community-scan-tenant acceptance
Lane acceptance: `.kiro/specs/mt-jobs/tasks.md` group `jobs-community-scan-tenant` (C1–C4; copy of the plan: `plan.md` here).
Suite: `services/gateway/test/vtid-05268-community-scan-tenant.test.ts` (12 tests). Output: `outputs/jest-vtid-05268.txt`.
Everything ships dark: `MT_RESOLUTION_V2` unset ⇒ today's platform-wide scan, today's event payload, today's backfill env list.

AC-1 (C1) — `runCommunityScan(sb, { tenantId })` adds `.eq('tenant_id', tenantId)` to today's `.eq('is_primary', true)`: a member primary in A and secondary in B is scanned only in A's pass. Without `tenantId` the member set is today's.
TEST: services/gateway/test/vtid-05268-community-scan-tenant.test.ts › C1 runCommunityScan({ tenantId })
AC-2 (C1) — In a tenant pass the per-member clock keeps today's chain (reminder tz → remembered timezone fact) and the tenant's `tenant_settings.timezone` replaces the platform default at the end of it (no member tz, empty or `UTC`).
TEST: services/gateway/test/vtid-05268-community-scan-tenant.test.ts › C1 › the tenant timezone is the final default of the member clock
AC-3 (C1/C1b) — `runCommunityScanForTenants` runs one pass per active tenant in sequence; top-level fields keep today's names/types with the four counts summed, plus `per_tenant`.
TEST: services/gateway/test/vtid-05268-community-scan-tenant.test.ts › C1/C1b runCommunityScanForTenants
AC-4 (C1b) — `/community-scan` emits exactly ONE `community_autopilot.scan.completed` event per call. Flag off ⇒ payload identical to today (six fields, no `per_tenant`). Flag on ⇒ active non-platform tenants only (members of the platform tenant or an inactive tenant are in no pass), six fields summed plus `per_tenant`. A single-member operator check (`user_id`) stays one run. The existing `test/routes/autopilot-recommendations.test.ts` CA-5 assertion stays green.
TEST: services/gateway/test/vtid-05268-community-scan-tenant.test.ts › C1b /community-scan route: one event per tick
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts › CA-5 community-scan endpoint
ROUTE_MOUNT: No new route and no new mount. The `router.post('/community-scan', …)` line in `services/gateway/src/routes/autopilot-recommendations.ts` is unchanged; only its body now chooses between today's run and the per-tenant tick. Mount unchanged.
FINAL_URL: POST {gateway}/api/v1/autopilot/recommendations/community-scan (pre-existing, unchanged)
CURL_PROOF: N/A for a new endpoint — path, method, auth and mount are unchanged. Staging verification is read-only (rule 48), so no POST is sent to staging; the route is driven through its Express router in the Jest suite above, and `staging-tests.json` checks `GET /alive` after the staging deploy.
AC-5 (C2) — Backfill loop tenant source: `MT_RESOLUTION_V2=true` and no `MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` ⇒ `activeTenantIds()` read on every tick; an env list stays the pinned override; master off ⇒ today (no env list ⇒ not started); shadow mode never starts the loop.
TEST: services/gateway/test/vtid-05268-community-scan-tenant.test.ts › C2 backfill loop tenant source
TEST: services/gateway/test/vtid-04786-memory-embedding-backfill-loop.test.ts (unchanged, green)
AC-6 (C4) — `plan.md`, `scope.json`, `staging-tests.json` in this directory.
TEST: docs/validation/VTID-05268/staging-tests.json (STAGING-VERIFY: `GET /alive` after the staging deploy, read-only)
OASIS_IMPACT: yes — `community_autopilot.scan.completed` gains a `per_tenant` array only when `MT_RESOLUTION_V2=true`; the six existing top-level fields keep their names and types (backward-compatible). Flag off ⇒ byte-identical payload. Still one event per call.
OASIS_PROOF: no new event type. `/community-scan` still emits exactly one `community_autopilot.scan.completed` per call through the existing emitter in `autopilot-recommendations.ts`; the C1b suite asserts one emit per tick, the flag-off payload equal to today's six fields, and the flag-on payload with summed counts plus `per_tenant`. State transitions only, no polling events (§6). Verify post-merge on staging logs (read-only): `SELECT type, metadata FROM oasis_events WHERE type = 'community_autopilot.scan.completed' ORDER BY created_at DESC LIMIT 5;`
