# STAGING-ACCEPTANCE.md — Phase 0 acceptance evidence

Status table for the 11 acceptance criteria in the Phase 0 handoff brief.
The parent session unblocks only when all 11 are green and this document
links to the evidence.

This file is a **scaffold** — the code that delivers each criterion is in
place, but the criteria that require external resources (Supabase branch
creation, Cloud Run services, GCS bucket, IAM grant, GCP secrets, the live
smoke runs) have not been executed yet. Those steps live behind the
CONFIRMATION GATE in the Phase 0 todo list: they cost money and are blast-
radius decisions, so the user is expected to read the code and authorize
each one explicitly.

Update each row's **Status** and **Evidence** as criteria pass.

| #  | Criterion                                                                                                   | Status   | Evidence                                                                                                                                                                                                                                                                          |
|----|-------------------------------------------------------------------------------------------------------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1  | `gateway-staging` deployed; `/api/v1/admin/health` returns `env:"staging"` + staging Supabase               | PENDING  | Awaiting external. Once STAGE-DEPLOY runs successfully, the workflow's own smoke step verifies this — link the green workflow run here.                                                                                                                                          |
| 2  | `community-app-staging` deployed; `VITE_GATEWAY_URL` at `gateway-staging`                                  | DEFERRED | Vitana-v1 frontend lives in a sibling repo; see docs/STAGING.md §6 — this criterion needs a parallel STAGE-DEPLOY-FRONTEND workflow in `exafyltd/vitana-v1`. Not in this PR's scope.                                                                                                |
| 3  | Supabase Persistent branch `staging`, migrations applied, seed populated (≥11 users, ≥50 memory rows)       | PENDING  | Seed file is in this PR ([supabase/seed.sql](../supabase/seed.sql)). After the user creates the persistent branch (P0.1, dashboard or CLI), capture `supabase branches list` showing Persistent + Active here.                                                                  |
| 4  | `.github/workflows/STAGE-DEPLOY.yml` exists and auto-deploys staging on every main push                     | DONE     | [STAGE-DEPLOY.yml](../.github/workflows/STAGE-DEPLOY.yml) is in this PR. Workflow runs once an actual main push happens. Prod EXEC-DEPLOY path is unchanged.                                                                                                                       |
| 5  | `/operator/publish` + `/operator/revert` implemented, wired to PUBLISH/CLOCK, write `software_versions` + OASIS | DONE     | Endpoints at [services/gateway/src/routes/operator.ts §publish/revert](../services/gateway/src/routes/operator.ts). UI at [command-hub-staging.js](../services/gateway/src/frontend/command-hub/command-hub-staging.js). Migration at [migration](../supabase/migrations/20260601000000_PHASE0_staging_software_versions.sql). |
| 6  | Feature-flag pattern in code with `FEATURE_<NAME>_ENV`                                                      | DONE     | [services/gateway/src/services/feature-flags.ts](../services/gateway/src/services/feature-flags.ts) — `isFeatureLive(name)` reads `FEATURE_<NAME>_ENV` with three values.                                                                                                          |
| 7  | PUBLISH button repurposed in production Command Hub; CLOCK shows full history with Revert                   | DONE     | [command-hub-staging.js](../services/gateway/src/frontend/command-hub/command-hub-staging.js) + integration in [app.js](../services/gateway/src/frontend/command-hub/app.js) (renderPublishModal + renderVersionDropdown).                                                          |
| 8  | New OASIS event topics defined in `cicd.ts`, emitted from the appropriate code paths                        | DONE     | Topics in [types/cicd.ts](../services/gateway/src/types/cicd.ts) tail (8 new entries). Emit sites: STAGE-DEPLOY.yml (staging.deploy.completed/failed), operator.ts (production.publish.{requested,completed,failed}, production.revert.completed, staging.revert.completed).      |
| 9  | **Smoke C** — full publish cycle (commit → staging → CLOCK → PUBLISH → prod)                                | PENDING  | Run after P0.2 brings up gateway-staging. Procedure in docs/STAGING.md §3. Capture workflow URLs + OASIS event IDs here.                                                                                                                                                          |
| 10 | **Smoke D** — revert proof (CLOCK → Revert → traffic shift within 30s → event)                              | PENDING  | Run after Smoke C produces at least 2 prod revisions. Procedure in docs/STAGING.md §4. Capture traffic-shift Cloud Run operation name + `production.revert.completed` event ID.                                                                                                  |
| 11 | **Isolation proof** — staging writes land in staging Supabase only; prod writes land in prod only           | PENDING  | Two simple psql probes after P0.1 + P0.2 land. Add evidence rows here.                                                                                                                                                                                                            |

## Smoke playbook

### Smoke C — publish cycle (criterion 9)

```bash
# 1. Trivial commit that mutates /api/v1/admin/build-info via env var.
gh secret list  # ensure BUILD_INFO_MARKER is editable per-workflow or set the
                # env var on the gateway-staging service via gcloud run services update
gcloud run services update gateway-staging --region=us-central1 \
  --update-env-vars=BUILD_INFO_MARKER=smoke-c-$(date +%s)

# 2. Trigger STAGE-DEPLOY (a no-op commit would also work; this is faster).
gh workflow run STAGE-DEPLOY.yml -f reason="smoke C"

# 3. Wait for the workflow to be green.
gh run watch

# 4. Verify new revision shows in CLOCK history.
curl https://gateway-staging-<hash>.us-central1.run.app/api/v1/admin/build-info
# expect: { ..., marker: "smoke-c-<ts>", ... }

# 5. Open production Command Hub PUBLISH → confirm + click Publish.
#    (UI flow; or call the API directly:)
curl -X POST https://gateway.vitanaland.com/api/v1/operator/publish \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"confirm_short_sha":"<7-char>"}'

# 6. Watch EXEC-DEPLOY (URL is returned in publish response).

# 7. Verify on prod:
curl https://gateway.vitanaland.com/api/v1/admin/build-info
# expect: { ..., marker: "smoke-c-<same-ts>", ... }
```

### Smoke D — revert (criterion 10)

```bash
# Pick a recent successful gateway revision from CLOCK history.
gcloud run revisions list --service=gateway --region=us-central1 --limit=5

# Trigger revert via API (or UI).
curl -X POST https://gateway.vitanaland.com/api/v1/operator/revert \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"service":"gateway","target_revision":"gateway-<prev>","confirm_short_sha":"<7-char>"}'

# Verify traffic shifted within 30s.
gcloud run services describe gateway --region=us-central1 \
  --format='value(status.traffic[].revisionName,status.traffic[].percent)'
```

### Smoke E — staging revert independence

Run Smoke D against `gateway-staging` and verify prod traffic split is
unchanged. Reverts on staging must not touch prod and vice-versa.

### Isolation proof (criterion 11)

```bash
# 1. From a gateway-staging shell (or curl with admin auth):
curl -X POST https://gateway-staging-<hash>.us-central1.run.app/api/v1/<some-staging-only-write> \
  -H "Authorization: Bearer $ADMIN_JWT"

# 2. Verify the row exists in the staging branch:
psql "$STAGING_SUPABASE_URL" -c "SELECT count(*) FROM <table> WHERE <recent>"

# 3. Verify it does NOT exist in prod:
psql "$PROD_SUPABASE_URL" -c "SELECT count(*) FROM <table> WHERE <recent>"

# 4. Repeat in the other direction (prod write, prod-only).
```

When all rows above are DONE/PASS (or explicitly DEFERRED with an issue link),
the parent session can resume by reading this file.
