# Vitana Staging Environment

**Phase 0 staging build — handoff brief P0.9.**

This file is the canonical reference for the Vitana staging stack. It exists
so that the 48-day autonomous fine-tuning + brain-unification experiment can
run without touching production. It also documents the publish + revert flows
that promote staging changes into production.

---

## 0. URLs (Lovable-style preview)

|        | Live (prod)                       | Preview (staging)                       |
|--------|-----------------------------------|-----------------------------------------|
| Frontend (community app) | `https://vitanaland.com`            | `https://preview.vitanaland.com`        |
| Backend gateway          | `https://gateway.vitanaland.com`    | `https://preview-gateway.vitanaland.com`|
| Command Hub (operator)   | `gateway.vitanaland.com/command-hub`| `preview-gateway.vitanaland.com/command-hub` |
| Supabase                 | `inmkhvwdcuyhnxkgfvsb.supabase.co`  | `rsdakjqpvcpgomltdmxu.supabase.co` (Persistent branch `Staging`) |

How the preview URLs work: Cloudflare DNS has a proxied CNAME for each
preview hostname pointing at the corresponding Cloud Run `*.run.app`
service.  Because Cloud Run rejects requests whose Host header doesn't
match either the `*.run.app` URL or a registered custom-domain mapping
(which would need Google Search Console verification of every subdomain),
a tiny Cloudflare Worker — [cloudflare/preview-router](../cloudflare/preview-router/)
— sits in front and rewrites the Host header to the `*.run.app` value
before fetching the origin.  Origin Rules with HostHeader override would
solve this too but are a paid Cloudflare feature (`not entitled to use
the HostHeader override`), so the Worker is the cheapest correct fix.

To add a new preview hostname (e.g. another staging service):
1. `cloudflare/preview-router/worker.js` — add the hostname to the
   `ROUTES` map.
2. `cloudflare/preview-router/wrangler.toml` — add the hostname to the
   `routes` array.
3. Cloudflare API → `POST /zones/{zone_id}/dns_records` adding a CNAME
   for the hostname with `proxied: true`.
4. Push to main; the existing `DEPLOY-CLOUDFLARE-WORKERS.yml` workflow
   auto-deploys when files under `cloudflare/preview-router/` change.

---

## 1. Architecture

```
                  ┌─────────────────────────────────────────────────┐
                  │                  GitHub `main`                   │
                  └──────────────────────────┬──────────────────────┘
                                             │
              ┌──────────────────────────────┴──────────────────────────────┐
              │                                                              │
   STAGE-DEPLOY.yml (auto                                       AUTO-DEPLOY.yml
   on every push to main)                                       (VTID-gated;
              │                                                  governance + EXEC-DEPLOY)
              ▼                                                       │
   ┌──────────────────────┐                                           ▼
   │  gateway-staging     │                                ┌──────────────────────┐
   │  Cloud Run service   │                                │  gateway             │
   │  • VITANA_ENV=staging│                                │  Cloud Run service   │
   │  • staging Supabase  │                                │  • production env    │
   │  • *.run.app URL     │                                │  • production Supabase│
   └──────────┬───────────┘                                └──────────┬───────────┘
              │                                                       ▲
              │       PUBLISH button in production Command Hub        │
              │       POST /api/v1/operator/publish                   │
              └────────► Cloud Run Admin API + EXEC-DEPLOY.yml ───────┘

   ┌──────────────────────────────────────────────────────────────────┐
   │  Supabase                                                         │
   │  • main branch       — production data store                      │
   │  • staging branch    — Persistent branch (data-isolated), seeded  │
   │                        via supabase/seed.sql                      │
   │  Migrations:        flow main→staging on dashboard merge          │
   └──────────────────────────────────────────────────────────────────┘
```

Two stacks, same code on `main`, gated by `VITANA_ENV`:

- **gateway-staging** → staging Supabase branch, *.run.app URL, no DNS.
- **gateway**         → production Supabase, `gateway.vitanaland.com`.

Both deploy from the same `services/gateway/` source. The env-aware code path
introduced in P0.3 (`src/env.ts`, `src/services/feature-flags.ts`) means a
single commit can carry behavior gated to staging only.

## 2. How to deploy code to staging

Push to `main`. That's it.

`.github/workflows/STAGE-DEPLOY.yml` listens to pushes under
`services/gateway/**` (and the workflow file itself) on `main`. Every push
triggers a fresh `gateway-staging` revision via `gcloud run deploy --source=`,
attaches the staging Supabase secrets, sets `VITANA_ENV=staging`, and runs a
smoke test against `/api/v1/admin/health`. The smoke FAILS the workflow if
the response does not include `"env":"staging"` — the strongest single
contract that env-aware code wires through to runtime.

After a successful deploy, STAGE-DEPLOY:

1. Writes a `software_versions` row (`environment='staging'`, `deploy_type='normal'`).
2. Emits an `staging.deploy.completed` OASIS event (with `metadata.env='staging'`).

Both feed the CLOCK history view in the Command Hub.

### Manual staging redeploy

```bash
gh workflow run STAGE-DEPLOY.yml -f reason="manual smoke"
```

No VTID required for staging deploys. The VTID-allocator hard gate applies to
production deploys via EXEC-DEPLOY.yml, not here.

## 3. How to publish staging → production

1. Open the **production** Command Hub (`https://gateway.vitanaland.com/command-hub/`).
   The `/api/v1/admin/health` endpoint returns `"env":"production"`, which the
   Command Hub uses to decide which PUBLISH-modal variant to render.
2. Click **PUBLISH** in the top bar.
3. The modal shows a "Promote staging → production" card:
   - Source: current `gateway-staging` active revision (short SHA + timestamp).
   - Target: `gateway` production.
   - Live metrics: bake-time, recent failure rate.
4. Type the 7-char short SHA into the confirm field.
5. Click **Publish to Production**.

Server flow (`POST /api/v1/operator/publish`):

1. `requireAdminAuth` — admin JWT + `exafy_admin` role.
2. Describe `gateway-staging` → resolve active revision + commit SHA.
3. Refuse if the staging revision is younger than
   `STAGING_PUBLISH_BAKE_SECONDS` (default 3600s; set to 0 for smoke tests).
4. Allocate a VTID via the canonical allocator (EXEC-DEPLOY needs the ledger row).
5. Call `deployOrchestrator.executeDeploy({ service:'gateway', environment:'production' })`.
6. Insert `software_versions` row with `source_revision`, `initiator_id`.
7. Emit `production.publish.requested` + `production.publish.completed` events.

The new prod revision becomes active once EXEC-DEPLOY finishes (~5min). The
publish-staging card surfaces the workflow URL inline so the operator can
watch progress.

## 4. How to revert

1. In the Command Hub top bar, click the **CLOCK** icon to open the version
   dropdown.
2. Find the revision you want to roll back to. Eligible rows show a small
   red "Revert" button — eligibility means `status='success'`, has a
   `cloud_run_revision`, age < 90 days, and not currently active.
3. Click **Revert**. A confirm overlay opens.
4. Type the 7-char commit short SHA. Click **Revert**.

Server flow (`POST /api/v1/operator/revert`):

1. Validate `service` ∈ `{gateway, gateway-staging}`.
2. List revisions on the service, verify target exists + not active + not
   expired.
3. Call Cloud Run Admin API `updateService(traffic)` → 100% to target.
4. Insert `software_versions` row with `deploy_type='rollback'`.
5. Emit `production.revert.completed` or `staging.revert.completed`.

Traffic shifts complete in ~30s — no rebuild. The revert button works on
both prod and staging Command Hubs (it operates on whichever stack the
caller is currently viewing, via the `service` body parameter).

## 5. Migration / publish decoupling

Schema migrations on Supabase are INDEPENDENT of the gateway publish flow:

- **Migration** = `RUN-MIGRATION.yml` applies a single SQL file to a Supabase
  project (main or staging branch). Triggered manually with the migration
  filename as input.
- **Publish** = `POST /api/v1/operator/publish` moves Cloud Run traffic on
  `gateway`. Does not touch the database.

**Two implications:**

1. **Use additive-only migrations.** New columns with defaults. New tables.
   No DROP, no rename, no NOT NULL on existing columns. The gateway code on
   both staging and prod must work against the schema both BEFORE and AFTER
   the migration lands (expand/contract pattern).
2. **Decide migration-publish ordering deliberately.** For a new column the
   code reads-without-requiring: migrate first, then publish. For a new
   column the code WRITES to and assumes exists: publish first to expose
   defensive reads, then migrate, then publish again to enable the write
   path. The brief calls this out explicitly because the Supabase
   "merge branch into main from the dashboard" flow LOOKS like a deploy
   but is independent of the Cloud Run publish.

**Never** click "Merge into main" on the Supabase `staging` branch from the
dashboard without an explicit decision from the user. Doing so will copy any
migrations applied to staging into production, regardless of whether the
prod gateway revision is compatible.

## 6. What's NOT in staging

- **No Cloudflare DNS.** Staging workers ship to `*.workers.dev` URLs (`wrangler deploy --env staging`).
- **No custom domain on gateway-staging.** *.run.app is the URL.
- **No community-app-staging in this repo.** The `vitana-v1` frontend deploys
  its own community-app to production; a parallel STAGE-DEPLOY-FRONTEND
  workflow lives in that repo (out of vitana-platform scope). When the
  parent session needs frontend staging, that workflow is the right home.
- **No CI/CD lock contention.** STAGE-DEPLOY does not consume the EXEC-DEPLOY
  concurrency lock, so a staging deploy NEVER blocks a prod publish in
  flight (and vice-versa).

## 7. Feature flags

Convention introduced in P0.3 (`services/gateway/src/services/feature-flags.ts`):

```typescript
import { isFeatureLive } from '../services/feature-flags';

if (isFeatureLive('FINETUNED_GREETING')) {
  // …
}
```

Env var: `FEATURE_<NAME>_ENV` with values `off | staging-only | staging+prod`.
Unset = `off`. Same code on `main` ships to both stacks; behavior is gated
per Cloud Run service via the env var. Graduation pattern:

```
off  →  staging-only  →  staging+prod
```

Rollback = flip the env var, no redeploy required (a Cloud Run env-var
update is a new revision but reuses the same image).

## 8. Diagnostic endpoints

Both auth-free (no admin JWT). Carry no secrets — only environment identity.

- `GET /api/v1/admin/health` →
  `{ ok, env: 'production'|'staging', supabase_host, cloud_run_service,
     cloud_run_revision, booted_at }`
- `GET /api/v1/admin/build-info` →
  `{ ok, env, cloud_run_service, cloud_run_revision, git_commit, booted_at, marker }`

The `marker` field is set from `BUILD_INFO_MARKER` env var (STAGE-DEPLOY
sets it to the short SHA). Useful as the trivial-change target for Smoke C
(publish-cycle proof).

## 9. Required GCP secrets

Created in P0.1 / P0.2 BEFORE the first STAGE-DEPLOY run can succeed:

```bash
echo -n "<STAGING_SUPABASE_URL>"               | gcloud secrets create STAGING_SUPABASE_URL --data-file=-
echo -n "<STAGING_SUPABASE_SERVICE_ROLE_KEY>"  | gcloud secrets create STAGING_SUPABASE_SERVICE_ROLE_KEY --data-file=-
echo -n "<STAGING_SUPABASE_ANON_KEY>"          | gcloud secrets create STAGING_SUPABASE_ANON_KEY --data-file=-
```

Plus the one-time IAM grant for the gateway service account (publish/revert
needs Cloud Run Admin API access):

```bash
gcloud projects add-iam-policy-binding lovable-vitana-vers1 \
  --member="serviceAccount:vitana-vertex-ai-service@lovable-vitana-vers1.iam.gserviceaccount.com" \
  --role="roles/run.developer"
```

(The gateway's `roles/run.viewer` permissions are implicit via `roles/run.developer`.)

## 9b. Staging-branch migration gap (record of state on 2026-05-22)

Supabase's branch auto-apply mechanism failed mid-replay when the `staging`
branch was first provisioned (status: `MIGRATIONS_FAILED`). A direct three-pass
Node + `pg` runner against the IPv4 shared pooler then applied the migrations
manually:

- **234 of 348** migration files applied cleanly.
- **114** failed with real schema issues (Postgres 17 reserved-word changes
  like `window`, ALTER statements that assumed columns added out-of-band on
  prod, references to tables — `products`, `profiles`, `live_rooms`,
  `calendar_events`, `catalog_sources`, `vitana_index_config` — that the
  migrations directory never creates).
- **280 tables** ended up on staging vs 320+ on prod.

The critical tables for Phase 0's publish/revert flow + the 48-day fine-tune
experiment **are all present** with the right schema: `software_versions` (with
the new `cloud_run_revision`, `source_revision`, `initiator_id` columns),
`oasis_events`, `vtid_ledger`, `app_users`, `memory_items`, `memory_facts`,
`autopilot_recommendations`, `user_tenants`, `tenants`.

A one-time schema patch was applied on top of the failed replay so the
`on_auth_user_platform_provision` trigger fires correctly during seed runs:

```sql
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS tenant_id uuid;
UPDATE public.tenants SET tenant_id = id WHERE tenant_id IS NULL;
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS tenant_id uuid,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS profile jsonb,
  ADD COLUMN IF NOT EXISTS live_room_id uuid,
  ADD COLUMN IF NOT EXISTS vitana_id text,
  ADD COLUMN IF NOT EXISTS country_code text,
  ADD COLUMN IF NOT EXISTS locale text;
INSERT INTO public.tenants (id, slug, name, tenant_id)
VALUES ('11111111-1111-1111-1111-111111111111', 'maxina', 'Maxina',
        '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO UPDATE
  SET tenant_id = COALESCE(public.tenants.tenant_id, EXCLUDED.tenant_id);
```

These columns exist on prod under names the replay couldn't reproduce; the
patch is staging-only and lives here, not in the migrations directory,
because it represents replay drift rather than a real schema change.

If the parent session needs any of the missing tables (`products`, `profiles`,
`live_rooms`, `calendar_events`, `catalog_sources`, `vitana_index_config`),
the right fix is either:
- inspect the failing migration files and write replay-safe versions, OR
- `pg_dump --schema-only` from prod (once an IPv6-reachable host is available)
  and `psql` the dump into staging.

Do **not** re-dispatch STAGE-DEPLOY to recover — that workflow does not touch
the database; only the manual replay path does.

## 10. Pointer index

| Thing                              | Where                                                              |
|------------------------------------|--------------------------------------------------------------------|
| `VITANA_ENV` resolver              | [services/gateway/src/env.ts](../services/gateway/src/env.ts)      |
| Feature-flag helper                | [services/gateway/src/services/feature-flags.ts](../services/gateway/src/services/feature-flags.ts) |
| /admin/health route                | [services/gateway/src/routes/admin-health.ts](../services/gateway/src/routes/admin-health.ts) |
| Cloud Run Admin client             | [services/gateway/src/services/cloud-run-admin.ts](../services/gateway/src/services/cloud-run-admin.ts) |
| /operator/publish + /revert        | [services/gateway/src/routes/operator.ts](../services/gateway/src/routes/operator.ts) |
| Software-versions migration        | [supabase/migrations/20260601000000_PHASE0_staging_software_versions.sql](../supabase/migrations/20260601000000_PHASE0_staging_software_versions.sql) |
| Staging seed                       | [supabase/seed.sql](../supabase/seed.sql)                          |
| STAGE-DEPLOY workflow              | [.github/workflows/STAGE-DEPLOY.yml](../.github/workflows/STAGE-DEPLOY.yml) |
| Command Hub publish/revert UI      | [services/gateway/src/frontend/command-hub/command-hub-staging.js](../services/gateway/src/frontend/command-hub/command-hub-staging.js) |
| Cloudflare worker staging variants | [cloudflare/vitanaland-og-proxy/wrangler.toml](../cloudflare/vitanaland-og-proxy/wrangler.toml), [cloudflare/email-intake-worker/wrangler.toml](../cloudflare/email-intake-worker/wrangler.toml) |
