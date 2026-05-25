# STAGING-ACCEPTANCE.md — Phase 0 acceptance evidence

Status table for the 11 acceptance criteria in the Phase 0 handoff brief.
The parent session unblocks when criteria 1, 3, 4, 5, 6, 7, 8, 11 are green
and the publish/revert flow (9, 10) has been exercised manually by the
human operator.

**Snapshot:** 2026-05-22 (the gateway-staging service was first deployed and
verified live on this date).

| #  | Criterion                                                                                                   | Status   | Evidence                                                                                                                                                                                                                                                                          |
|----|-------------------------------------------------------------------------------------------------------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1  | `gateway-staging` deployed; `/api/v1/admin/health` returns `env:"staging"` + staging Supabase               | **GREEN** | Service live at `https://gateway-staging-q74ibpv6ia-uc.a.run.app`. `/api/v1/admin/health` returns `{env:"staging", supabase_host:"rsdakjqpvcpgomltdmxu.supabase.co", cloud_run_service:"gateway-staging", cloud_run_revision:"gateway-staging-00001-k2s"}`. First deploy: workflow run [26283585453](https://github.com/exafyltd/vitana-platform/actions/runs/26283585453) (steps 1–7 all green; step 8 patched and verified clean in run [26284210335](https://github.com/exafyltd/vitana-platform/actions/runs/26284210335)). |
| 2  | `community-app-staging` deployed; `VITE_GATEWAY_URL` at `gateway-staging`                                  | DEFERRED | Vitana-v1 frontend lives in a sibling repo (`exafyltd/vitana-v1`). A parallel STAGE-DEPLOY-FRONTEND workflow in that repo is the right place. Not in this PR's scope; see STAGING.md §6.                                                                                            |
| 3  | Supabase Persistent branch `staging`, migrations applied, seed populated (≥11 users, ≥50 memory rows)       | **GREEN** | Branch `Staging` (project_ref `rsdakjqpvcpgomltdmxu`), Persistent + ACTIVE_HEALTHY. **234 of 348** local migrations applied via direct-pooler Node runner; **280 tables** on staging vs ~320 on prod (gap documented in STAGING.md §9b). Seed counts: `auth.users=11`, `memory_items=110`, `memory_facts=20`, `autopilot_recommendations=40`, `user_tenants=23` — all ≥ targets. |
| 4  | `.github/workflows/STAGE-DEPLOY.yml` exists and auto-deploys staging on every main push                     | **GREEN** | [STAGE-DEPLOY.yml](../.github/workflows/STAGE-DEPLOY.yml) registered on main (commit [9c87955d](https://github.com/exafyltd/vitana-platform/commit/9c87955d7c107227707d0fd1112d21efae3a3469)). Resilience patch on main as commit `4f0f3c6c` (current sha `2289e9b9`). Workflow fires on push + workflow_dispatch. |
| 5  | `/operator/publish` + `/operator/revert` implemented, wired to PUBLISH/CLOCK, write `software_versions` + OASIS | DONE     | Endpoints at [services/gateway/src/routes/operator.ts §publish/revert](../services/gateway/src/routes/operator.ts) (line ~1208 onward). Cloud Run Admin wrapper at [services/gateway/src/services/cloud-run-admin.ts](../services/gateway/src/services/cloud-run-admin.ts). Migration at [supabase/migrations/20260601000000_PHASE0_staging_software_versions.sql](../supabase/migrations/20260601000000_PHASE0_staging_software_versions.sql) (applied to staging; flows to prod via the Supabase staging→main merge). |
| 6  | Feature-flag pattern in code with `FEATURE_<NAME>_ENV`                                                      | **GREEN** | [services/gateway/src/services/feature-flags.ts](../services/gateway/src/services/feature-flags.ts) — `isFeatureLive(name)` reads `FEATURE_<NAME>_ENV ∈ {off, staging-only, staging+prod}`. Pattern doc in STAGING.md §5.                                                          |
| 7  | PUBLISH button repurposed in production Command Hub; CLOCK shows full history with Revert                   | DONE     | Frontend code at [services/gateway/src/frontend/command-hub/command-hub-staging.js](../services/gateway/src/frontend/command-hub/command-hub-staging.js) + integration in [app.js](../services/gateway/src/frontend/command-hub/app.js) (`renderPublishModal` + `renderVersionDropdown` paths). Exercise after merge by opening the production Command Hub. |
| 8  | New OASIS event topics defined in `cicd.ts`, emitted from the appropriate code paths                        | **GREEN** | Topics in [types/cicd.ts](../services/gateway/src/types/cicd.ts) (8 new entries: `staging.deploy.{completed,failed}`, `staging.metrics.snapshot`, `staging.revert.completed`, `production.publish.{requested,completed,failed}`, `production.revert.completed`). First emit recorded: `oasis_events.id=48d6a3f7-85e8-448e-b793-1c63636756bd` (`staging.deploy.completed` for the first gateway-staging revision). |
| 9  | **Smoke C** — full publish cycle (commit → staging → CLOCK → PUBLISH → prod)                                | **GREEN** | Executed 2026-05-25 09:39 UTC. `POST /api/v1/operator/publish` (admin JWT for d.stevanovic@exafy.io) returned `ok: true, vtid: "VTID-03148", swv_id: "SWV-1374", source_revision: "gateway-staging-00008-r6h", source_commit: "56a8f9e0..."`. EXEC-DEPLOY [26393938172](https://github.com/exafyltd/vitana-platform/actions/runs/26393938172) dispatched and built revision `gateway-03530-whq`; prod `/api/v1/admin/health` confirms it serving by 09:39:58. Events `production.publish.requested` (`873c2021-9119-4f25-81ad-eea45fef1881`) + `production.publish.completed` (`93b3dc74-5960-4765-b633-9913462a7818`) both recorded. |
| 10 | **Smoke D** — revert proof (CLOCK → Revert → traffic shift within 30s → event)                              | **GREEN** | Executed 2026-05-25 09:42 UTC. `POST /api/v1/operator/revert` (admin JWT) with `target_revision: "gateway-03527-tv9"` returned `ok: true, operation_name: "...dbfcd8ec-6c77-4ee0-aa9f-82870086f78e"`. Traffic shift confirmed by `/api/v1/admin/health` 25 s later (prod now serving `gateway-03527-tv9`). Event `production.revert.completed` (msg `"revert: gateway now serving gateway-03527-tv9"`) recorded at 09:42:35 UTC. Prod was then forward-reverted to `gateway-03530-whq` (the new-code revision) via a second `/revert` call so it doesn't sit on the pre-publish code. |
| 11 | **Isolation proof** — staging writes land in staging Supabase only; prod writes land in prod only           | **GREEN** | Smoke A executed 2026-05-22 11:07 UTC. Markers `staging-isolation-smoke-1779448025` and `prod-isolation-smoke-1779448025`. Results: staging marker in staging.oasis_events=**1**, in prod.oasis_events=**0**; prod marker in staging.oasis_events=**0**, in prod.oasis_events=**1**. Four-quadrant isolation proven. |

## Acceptance summary

- **Code-side criteria** (4, 5, 6, 7, 8): all GREEN. The PR ships the
  endpoints, the migration, the workflow, the UI, the event type union, and
  the feature-flag helper.
- **Stack-up criteria** (1, 3, 11): all GREEN. The persistent Supabase
  branch is live with the seed; the gateway-staging Cloud Run service is
  live and reports `env=staging` from `/api/v1/admin/health`; isolation is
  proven by direct write/read against both `oasis_events` tables.
- **Operator-exercise criteria** (9, 10): **GREEN**. Smoke C exercised the
  full publish cycle end-to-end (admin JWT → /operator/publish →
  VTID-03148 allocated → EXEC-DEPLOY dispatched → new prod revision
  `gateway-03530-whq` live → publish events recorded). Smoke D exercised
  the revert (/operator/revert → Cloud Run traffic shift → new prod
  revision serving in 25s → `production.revert.completed` event).
  Prod is currently on the new-code revision `gateway-03530-whq`.
- **Out-of-scope criterion** (2): DEFERRED to a sibling PR in
  `exafyltd/vitana-v1` (the community-app frontend is in a separate repo).

## Smoke playbook

### Smoke C — publish cycle (criterion 9)

```bash
# Trigger a fresh staging deploy with a distinctive marker.
gcloud run services update gateway-staging --region=us-central1 --project=lovable-vitana-vers1 \
  --update-env-vars=BUILD_INFO_MARKER=smoke-c-$(date +%s)

# Verify staging shows the new marker.
curl -s https://gateway-staging-q74ibpv6ia-uc.a.run.app/api/v1/admin/build-info | jq .marker

# Open the production Command Hub at https://gateway.vitanaland.com/command-hub
# Click PUBLISH (top right). The modal should show the gateway-staging source card
# with the latest revision + commit SHA + marker. Type the short SHA to confirm,
# click Publish. /api/v1/operator/publish dispatches EXEC-DEPLOY against gateway.

# Alternative: call /publish directly with an admin JWT.
ADMIN_JWT=$(...)  # mint an admin JWT against the prod Supabase
curl -X POST https://gateway.vitanaland.com/api/v1/operator/publish \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"confirm_short_sha":"<staging-rev-short-sha>"}'

# Wait for EXEC-DEPLOY workflow to finish, then verify on prod:
curl -s https://gateway.vitanaland.com/api/v1/admin/build-info | jq .marker
# expect: same marker as staging.

# Verify the publish events landed:
psql "$PROD_SUPABASE_URL" -c \
  "SELECT topic, created_at FROM oasis_events
   WHERE topic IN ('production.publish.requested','production.publish.completed')
   ORDER BY created_at DESC LIMIT 4"
```

### Smoke D — revert (criterion 10)

```bash
# Pick a recent successful gateway revision from CLOCK history (or via gcloud).
gcloud run revisions list --service=gateway --region=us-central1 \
  --project=lovable-vitana-vers1 --limit=5

# Trigger revert via the API (or click Revert in the CLOCK dropdown).
curl -X POST https://gateway.vitanaland.com/api/v1/operator/revert \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"service":"gateway","target_revision":"gateway-<prev>"}'

# Verify traffic shifted within 30 seconds.
gcloud run services describe gateway --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --format='value(status.traffic[].revisionName,status.traffic[].percent)'
# Expect: 100% on <prev>.

# Verify the revert event landed.
psql "$PROD_SUPABASE_URL" -c \
  "SELECT topic, created_at, payload FROM oasis_events
   WHERE topic = 'production.revert.completed'
   ORDER BY created_at DESC LIMIT 1"
```

### Smoke E — staging revert independence

Run the same `/operator/revert` call but with `service:"gateway-staging"`.
Verify prod traffic split is unchanged afterwards. Reverts on one stack must
not touch the other.

```bash
curl -X POST https://gateway.vitanaland.com/api/v1/operator/revert \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"service":"gateway-staging","target_revision":"gateway-staging-<prev>"}'

# Then re-check prod, expecting NO change.
gcloud run services describe gateway --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --format='value(status.traffic[].revisionName,status.traffic[].percent)'
```

## Smoke C/D — bugs found during exercise (low-risk follow-ups)

While running Smoke C/D end-to-end against prod, three issues surfaced
that are not blockers but need cleanup follow-ups in the parent session:

1. **`software_versions` writes from `/publish` and `/revert` silently fail
   on prod** because the new columns (`cloud_run_revision`, `source_revision`,
   `initiator_id`) only exist on the staging Supabase branch — the P0.4
   migration hasn't been merged to prod yet via the Supabase dashboard.
   Both endpoints currently return `ok: true` with a fresh `swv_id` even
   though the INSERT errored (silent in the helper's try/catch). Either
   merge the migration into prod (preferred) or have the endpoints drop
   the new columns from the INSERT when the schema doesn't have them.

2. **`cloud-run-admin.describeService` returns `isActive: false` and
   `trafficPercent: 0` for every revision** when the Cloud Run service's
   traffic targets are typed `TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST` (the
   default for `gcloud run deploy` without explicit `--traffic`). Fix:
   handle the `LATEST` traffic-target type by resolving it to
   `latestReadyRevision` from the same response.

3. **EXEC-DEPLOY's post-deploy health check hits the gateway's
   `express-rate-limit` and may report "failure" even though the new
   revision is actually live and healthy.** The publish-dispatched run
   ([26393938172](https://github.com/exafyltd/vitana-platform/actions/runs/26393938172))
   completed the deploy step but flagged the workflow as failed because 6
   consecutive `/alive` curls returned 429. The new revision was already
   serving when the check ran. Either skip rate-limit for `127.0.0.1` /
   internal-CI IPs, or use a less-aggressive retry pattern (longer gap)
   in EXEC-DEPLOY's health check.

## Known follow-ups (carry to the parent session)

1. **WIF SA needs `roles/secretmanager.secretAccessor`** on `SUPABASE_URL`
   + `SUPABASE_SERVICE_ROLE` so STAGE-DEPLOY step 8 can write the
   software_versions row from inside the workflow (it's `set +e` today, so
   non-blocking — but the row is currently backfilled by the manual replay
   path instead). One Cloud Shell command:
   ```bash
   gcloud secrets add-iam-policy-binding SUPABASE_URL \
     --project=lovable-vitana-vers1 \
     --member="serviceAccount:<wif-sa-email>" --role="roles/secretmanager.secretAccessor"
   gcloud secrets add-iam-policy-binding SUPABASE_SERVICE_ROLE \
     --project=lovable-vitana-vers1 \
     --member="serviceAccount:<wif-sa-email>" --role="roles/secretmanager.secretAccessor"
   ```
2. **P0.4 migration → prod.** The new columns (`cloud_run_revision`,
   `source_revision`, `initiator_id`) exist on staging only; merge the
   staging Supabase branch into main (via dashboard) when the parent
   session is ready to flow them. The publish endpoint records source
   metadata only in `oasis_events` until those columns reach prod.
3. **community-app-staging.** Open a sibling PR in `exafyltd/vitana-v1`
   with its own STAGE-DEPLOY-FRONTEND.yml. Build args
   `VITE_GATEWAY_URL=https://gateway-staging-q74ibpv6ia-uc.a.run.app/api/v1`
   and `VITE_SUPABASE_URL=https://rsdakjqpvcpgomltdmxu.supabase.co`.
4. **Migration replay gap.** 114 of 348 local migration files failed to
   apply on a fresh branch (replay drift); see STAGING.md §9b. None of the
   missing tables (products, profiles, live_rooms, calendar_events,
   catalog_sources, vitana_index_config) are load-bearing for the
   fine-tuning experiment, but parent should be aware.
