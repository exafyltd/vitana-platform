# Release Backlog & Versioning — verification checklist

**Status:** Test plan + verification checklist for the work pushed in PRs
[#1191](https://github.com/exafyltd/vitana-platform/pull/1191) (vitana-platform)
and [#340](https://github.com/exafyltd/vitana-v1/pull/340) (vitana-v1).

This document is the authoritative "how do we know it works" guide. It covers
**three tiers**:

1. **Automated** — `scripts/test-release-backlog.ts` (one runnable file, three sections)
2. **Manual deploy verification** — things you only know work after CI + deploy
3. **External integration verification** — things that need real third-party creds

---

## 1. Automated test (`scripts/test-release-backlog.ts`)

A single TypeScript file with three sections. Each section is gated by
env vars so you can run partial coverage locally and full coverage in CI.

### Run it

```bash
# Section 1 only — unit tests for pure functions. No infra needed.
node --import tsx scripts/test-release-backlog.ts

# Sections 1 + 2 — add Postgres schema verification.
DATABASE_URL=postgresql://user:pass@host:5432/db \
  node --import tsx scripts/test-release-backlog.ts

# Sections 1 + 2 + 3 — full E2E against a running gateway.
DATABASE_URL=postgresql://... \
  GATEWAY_URL=https://gateway.example.com \
  JWT_DEVELOPER=eyJ... \
  JWT_TENANT_ADMIN=eyJ... \
  JWT_COMMUNITY=eyJ... \
  node --import tsx scripts/test-release-backlog.ts
```

Exit code 0 = all run tests passed; 1 = something failed; 2 = harness crashed.

### What each section verifies

#### Section 1 — unit tests (no infrastructure)

Pure-function tests for the deterministic logic. These cannot regress without
a unit-test failure.

| Test | Verifies |
|------|----------|
| `parseSemver` cases | Strips `>=`, `>`, `~`, `^` operators correctly; handles incomplete versions |
| `compareSemver` cases | Major/minor/patch ordering; cross-operator comparisons |
| `computeCompatibility` cases | P2 logic: pin against `platform.sdk` only; null inputs → ok; below-min → breaking; major-ahead-of-target → behind |
| `isValidPromotion` cases | P3 logic: forward-only (internal→beta→stable); reject reverse; reject skip; allow idempotent re-promote |
| P4 surface defaults | desktop/ios/android/web → `public_changelog=true`; command_hub/api/sdk → `false` |

#### Section 2 — schema tests (need a Postgres URL)

Probes the database directly via SQL. Requires the migration
`20260510000000_release_backlog_v1.sql` to have been applied and the `pg`
Node module installed (`npm install pg`).

| Test | Verifies |
|------|----------|
| Tables exist | `release_components`, `release_history`, `release_backlog_items` all present |
| Critical columns + types | `public_changelog boolean`, `surface text`, `tenant_id uuid`, `changelog text`, `internal_notes text`, `vtid text` |
| CHECK constraint | `tenant_id` required when `owner='tenant'` |
| Indexes | All 4 indexes from the migration present (incl. partial `idx_release_backlog_vtid`) |
| RLS enabled | All 3 tables have `relrowsecurity=true` |
| R3 seed | At least 4 platform components, `platform.sdk.public_changelog=false`, `platform.web.public_changelog=true` |

#### Section 3 — API tests (need a running gateway + JWTs)

Hits each endpoint over HTTP. Requires:
- `GATEWAY_URL` pointing at a gateway with the new routes mounted
- One or more JWTs depending on which RBAC paths to verify

| Test | Verifies |
|------|----------|
| `GET /changelog/public` returns 200 + entries[] | R17 endpoint up |
| `GET /changelog/public` has `Cache-Control` header | R17 caching policy |
| `GET /overview` without JWT → 401 | Auth required (req.user check) |
| `GET /overview` as community → 403 | RBAC — community blocked |
| `GET /overview` as tenant_admin → 200 + tenants.length ≤ 1 | Tenant-scoping enforced |
| `GET /overview` as developer → 200 + full shape | Wire format matches spec § 4 |
| `GET /components` as developer → 200 | List endpoint works |
| `PATCH /components/:id` with `current_channel` → 400 | P3 enforcement — channel changes must use `/promote` |
| `POST /promote` with reverse channels → 400 | P3 forward-only |
| `POST /promote` with channel skip → 400 | P3 step-by-step |
| `GET /backlog` items have `vtid_linked` + `effective_status` | P1 + R12 read-through |
| `GET /docs/specs/*` as community → 403 | R8 + Q1 lockdown |
| `GET /docs/specs/../etc/passwd` → 400/404 | R8 path-traversal hardening |
| `GET /docs/specs/notallowed.md` → 404 | R8 allowlist enforced |

---

## 2. Manual deploy verification

Things the automated suite cannot cover, in order:

### 2.1 Migration applies cleanly

- [ ] Run on a fresh local DB: `pnpm exec prisma migrate deploy` (or apply the SQL directly)
- [ ] No errors
- [ ] Section 2 of `test-release-backlog.ts` returns all green

### 2.2 Gateway routes mounted

- [ ] In `services/gateway/src/index.ts`, both routers added per the require + mount pattern at lines ~250 + ~597:
  ```ts
  const { releasesRouter } = require('./routes/releases');
  const { devDocsRouter }  = require('./routes/dev-docs');
  // ...
  mountRouterSync(app, '/', releasesRouter, { owner: 'releases' });
  mountRouterSync(app, '/', devDocsRouter, { owner: 'dev-docs' });
  ```
- [ ] Gateway build succeeds: `cd services/gateway && pnpm run build`
- [ ] Gateway starts: `pnpm start`
- [ ] Section 3 of `test-release-backlog.ts` returns all green when pointed at it

### 2.3 Frontend routes mounted

In `vitana-v1`'s `src/App.tsx`:
- [ ] `/dev/releases` → lazy `<DevReleases />` inside the existing `/dev/*` block
- [ ] `/dev/docs/backlog` → lazy `<DevDocsBacklog />` (or wired into existing `DevDocs` tabs)
- [ ] `/admin/releases` → lazy `<AdminReleases />` inside `<ProtectedRoute requiredRole="admin">`
- [ ] `/changelog` → lazy `<Changelog />` (no guard, public)

Verify:
- [ ] App builds: `npm run build`
- [ ] Open `/dev/releases` while authed as developer — see matrix
- [ ] Open `/dev/docs/backlog` — see doc list, click "Release backlog — platform spec" loads via gateway
- [ ] Open `/admin/releases` while authed as tenant admin — see 3 tabs, all load
- [ ] Open `/changelog` while logged out — page renders

### 2.4 Admin sidebar entry (R11) — still pending

- [ ] Add `Releases` entry to MAXINA admin sidebar component (location TBD)
- [ ] Top-level placement, adjacent to System (per F1)
- [ ] Active highlighting works for `/admin/releases` and sub-tabs

### 2.5 Tenant rows seeded for MAXINA

The initial migration seeded 4 platform components only. MAXINA's tenant rows
(Desktop / iOS / Android) need a follow-up seed once the canonical `tenants.id`
for MAXINA is confirmed:

```sql
INSERT INTO release_components (slug, display_name, owner, tenant_id, surface, public_changelog,
                                min_platform_version, target_platform_version)
VALUES
  ('tenant.maxina.desktop', 'MAXINA Desktop', 'tenant', '<MAXINA_UUID>', 'desktop', TRUE,  '>=2.3.0', '2.3.0'),
  ('tenant.maxina.ios',     'MAXINA iOS',     'tenant', '<MAXINA_UUID>', 'ios',     TRUE,  '>=2.3.0', '2.3.0'),
  ('tenant.maxina.android', 'MAXINA Android', 'tenant', '<MAXINA_UUID>', 'android', TRUE,  '>=2.3.0', '2.3.0')
ON CONFLICT (slug) DO NOTHING;
```

- [ ] MAXINA tenant_id confirmed
- [ ] Above seed applied
- [ ] Tenant_admin's `/admin/releases` Overview tab shows MAXINA surfaces

---

## 3. External integration verification

Things that need real third-party credentials (per Phase 5 / R14, R15, R16).

### 3.1 App Store Connect (R14 — iOS)

Requires:
- `APP_STORE_CONNECT_KEY_ID` (string)
- `APP_STORE_CONNECT_ISSUER_ID` (string)
- `APP_STORE_CONNECT_PRIVATE_KEY` (PEM)

Verification path:
- [ ] Provision an App Manager API key in App Store Connect
- [ ] Set the env vars on the `release-publisher` Cloud Run service
- [ ] Implement the body of `services/release-publisher/src/handlers/ios.ts` per the TODO
- [ ] Promote a TestFlight build to stable; verify "What's New" updates within
      a minute on the App Store Connect side
- [ ] OASIS `release.publish.attempted` event recorded

### 3.2 Play Console (R15 — Android)

Requires:
- `PLAY_CONSOLE_SERVICE_ACCOUNT_JSON` (full JSON content)

Verification path:
- [ ] Create a Play Console service account with `androidpublisher` scope
- [ ] Set the env var on the worker
- [ ] Implement the body of `services/release-publisher/src/handlers/android.ts` per the TODO
- [ ] Promote an internal-track build to stable; verify release notes update
- [ ] OASIS event recorded

### 3.3 Cloudflare cache invalidation (R16 — Web)

Requires:
- `CLOUDFLARE_PURGE_TOKEN` (scoped token, Cache Purge permission)
- `CLOUDFLARE_ZONE_ID` (vitanaland.com zone)

The handler is implemented; just needs creds.

Verification path:
- [ ] Create a Cloudflare scoped API token
- [ ] Set both env vars on the worker
- [ ] Promote a `platform.web` release to stable
- [ ] `curl -I https://vitanaland.com/changelog` shows fresh content within seconds
- [ ] `release.publish.attempted` OASIS event followed by a successful path

### 3.4 Worker subscription health

Regardless of whether handler creds are set, verify the worker scaffold:
- [ ] `services/release-publisher/` builds: `cd services/release-publisher && npm run build`
- [ ] Worker starts: `npm start` (with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE`)
- [ ] Promote a test release to stable; worker logs show dispatch + the handler's `NOT_IMPLEMENTED` error (R14/R15) OR the actual purge call (R16)
- [ ] Retry/dead-letter: after 5 failed attempts, OASIS shows a `release.publish.failed` event

---

## 4. Phase 6 work not yet covered

These are the only deliberately unfinished pieces from the original 20-ticket plan:

- **R19 — OASIS event audit + standardization.** Events are emitted from
  every write point in `services/gateway/src/routes/releases.ts`, but the
  full taxonomy from spec § 5 is not yet audited / standardized.
- **R20 — Rollback flow.** The `release_history.rollback_of` column exists
  but no `POST /:id/rollback` endpoint or worker reverse-propagation has been
  implemented yet.

---

## 5. CI integration suggestion

A minimal addition to `.github/workflows/CICDL-GATEWAY-CI.yml` that runs the
automated suite against the workflow's ephemeral Postgres:

```yaml
- name: Apply release-backlog migration
  working-directory: services/gateway
  run: pnpm exec prisma migrate deploy || true  # already in pipeline

- name: Run release-backlog verification (sections 1+2)
  run: |
    npm install -g tsx
    DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vitana_test \
      tsx scripts/test-release-backlog.ts
```

Section 3 (API tests) belongs in a separate post-deploy smoke job since it
needs a running gateway and real JWTs.
