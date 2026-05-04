# Release Backlog & Versioning Overview

**Status:** Draft (refined after walkthrough — Command Hub placement resolved)
**Branch:** `claude/backlog-versioning-structure-7frZn`
**Companion spec:** `vitana-v1/docs/release-backlog-overview-screen.md`
**Decisions reference:** `vitana-v1/docs/role-cleanup-decisions.md`
**VTID:** _to be claimed before merge_

---

## 1. Goal

A single backlog + overview surface that answers, at any moment:

> Which version of every Vitanaland platform component is live, what's pending,
> and which tenant apps are compatible with it?

It must cover:

- **Vitanaland (platform)** — Command Hub, vitanaland.com web, gateway/API, SDK / tenant runtime
- **Tenants** — currently MAXINA (community app), with room for future tenants
- **Per-tenant platform surfaces** — Desktop (web responsive), iOS, Android

It must support release-channel separation (`internal` / `beta` / `stable`) and
make tenant ↔ platform compatibility visible at a glance.

---

## 2. Why this layout (not flat by Desktop / iOS / Android / Hub)

The user's first instinct was to split overview into Desktop / iOS / Android / Command Hub.
That collapses two orthogonal dimensions:

- **Who owns the release?** — Vitanaland (platform) vs each tenant
- **What is the surface?** — web / mobile / hub

Treating them as one flat list hides the platform-vs-tenant ownership boundary
and makes compatibility (tenant app pinned to platform SDK version) invisible.

Chosen layout:

```
Vitanaland (platform)
  ├─ Command Hub          (admin surface, single version)
  ├─ vitanaland.com web   (public site)
  ├─ Gateway / API        (services version)
  └─ SDK / Tenant runtime (what tenants build on)

Tenants
  └─ MAXINA  (tenant_id = ...)
       ├─ Desktop (web responsive)   — app version + min platform version
       ├─ iOS                        — app version + min platform version *(Community-only feature set)*
       └─ Android                    — app version + min platform version *(Community-only feature set)*
  └─ <future tenant>
       └─ ...
```

Each tenant-app row pins a **min platform version** and a **target platform
version**. The overview renders a compatibility badge per cell (`✓` / `⚠ behind` / `✗ breaking`).

> **Mobile policy** (decided in role walkthrough): MAXINA iOS and Android ship
> only the Community feature set. Compatibility tracking for mobile surfaces
> only ever compares against Community-scope platform contracts.

---

## 3. Data model

Mirrors the existing `routines` + `routine_runs` catalog/history pattern
(see `DATABASE_SCHEMA.md` § VTID-01981) so Command Hub can reuse the same UI shape.

> ⚠️ When this spec is implemented, both tables MUST be added to
> `DATABASE_SCHEMA.md` in the same commit per the CRITICAL RULES at the top of
> that file.

### `release_components`

Catalog: one row per shippable thing we version.
Covers **both** platform components and tenant-app surfaces.

```sql
CREATE TABLE release_components (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  TEXT NOT NULL UNIQUE,        -- e.g. 'platform.command-hub', 'tenant.maxina.ios'
  display_name          TEXT NOT NULL,               -- e.g. 'Command Hub', 'MAXINA iOS'
  owner                 TEXT NOT NULL CHECK (owner IN ('platform','tenant')),
  tenant_id             UUID,                        -- NULL when owner='platform'
  surface               TEXT NOT NULL CHECK (surface IN
                          ('command_hub','web','api','sdk','desktop','ios','android')),
  repo                  TEXT,                        -- e.g. 'exafyltd/vitana-v1'
  current_version       TEXT,                        -- semver, e.g. '1.4.2'
  current_channel       TEXT CHECK (current_channel IN ('internal','beta','stable')),
  current_released_at   TIMESTAMPTZ,
  current_release_id    UUID,                        -- → release_history.id
  -- Compatibility pinning (only meaningful when owner='tenant')
  min_platform_version  TEXT,                        -- e.g. '>=2.3.0'
  target_platform_version TEXT,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_id_required_for_tenant_owner
    CHECK ((owner = 'tenant' AND tenant_id IS NOT NULL)
        OR (owner = 'platform' AND tenant_id IS NULL))
);
CREATE INDEX idx_release_components_owner_tenant
  ON release_components(owner, tenant_id);
```

### `release_history`

Append-only log of every release event for a component. The `changelog` column
is what the tenant-side **Changelog tab** authors and what `/api/v1/releases/changelog/public`
serves to App Store / Play Store / in-app `/changelog` for stable releases.

```sql
CREATE TABLE release_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id    UUID NOT NULL REFERENCES release_components(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('internal','beta','stable')),
  released_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by     UUID,                            -- profiles.id
  changelog       TEXT,                            -- markdown, public when channel='stable'
  internal_notes  TEXT,                            -- never exposed to tenant role
  artifact_url    TEXT,                            -- App Store link, Cloud Run revision, etc.
  commit_sha      TEXT,
  rollback_of     UUID REFERENCES release_history(id),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_release_history_component_released
  ON release_history(component_id, released_at DESC);
CREATE INDEX idx_release_history_channel
  ON release_history(channel, released_at DESC);
```

### `release_backlog_items`

Pending work targeting a future release of a component. This is the "Backlog"
the user asked for.

```sql
CREATE TABLE release_backlog_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id  UUID NOT NULL REFERENCES release_components(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  summary       TEXT,
  vtid          TEXT,                              -- → vtid_ledger.vtid (optional link)
  status        TEXT NOT NULL CHECK (status IN
                  ('proposed','planned','in_progress','blocked','done','dropped')),
  target_version TEXT,                             -- e.g. '1.5.0'
  target_channel TEXT CHECK (target_channel IN ('internal','beta','stable')),
  visibility    TEXT NOT NULL DEFAULT 'internal'
                  CHECK (visibility IN ('internal','tenant','public')),
  priority      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_release_backlog_component_status
  ON release_backlog_items(component_id, status);
```

`vtid` deliberately optional: not every backlog item needs a VTID, but linking
keeps the existing VTID ledger as the single source of execution truth.

---

## 4. API endpoints (gateway)

Mounted at `services/gateway/src/routes/releases.ts` (new). Auth follows the
same Command Hub / tenant-admin pattern used by `routines`.

| Method | Path | Purpose | Roles |
|--------|------|---------|-------|
| `GET` | `/api/v1/releases/components` | List components (filters: `owner`, `tenant_id`, `surface`) | developer / super-admin / tenant_admin (own tenant only) |
| `GET` | `/api/v1/releases/components/:id` | Component detail incl. last 10 releases | as above |
| `POST` | `/api/v1/releases/components` | Register new component | developer / super-admin |
| `PATCH` | `/api/v1/releases/components/:id` | Update current version / channel / pins | developer / super-admin (any), tenant_admin (own tenant rows only) |
| `GET` | `/api/v1/releases/history` | Filter by `component_id`, `channel`, date range | as list |
| `POST` | `/api/v1/releases/history` | Record a release (creates history row + updates `current_*` on component atomically) | developer / super-admin / tenant_admin (own) |
| `GET` | `/api/v1/releases/backlog` | List backlog items, filterable; tenant role sees only `visibility IN ('tenant','public')` for their components | role-aware |
| `POST` `PATCH` `DELETE` | `/api/v1/releases/backlog/:id` | CRUD backlog items | developer / super-admin / tenant_admin (own) |
| `GET` | `/api/v1/releases/overview` | The matrix payload the overview screen renders in one call | role-aware |
| `GET` | `/api/v1/releases/changelog/public` | Public stable-channel changelog (no auth) | anyone |

### `/api/v1/releases/overview` shape (the screen calls this once)

```jsonc
{
  "platform": [
    { "slug": "platform.command-hub", "display_name": "Command Hub",
      "current_version": "2.3.4", "current_channel": "stable",
      "current_released_at": "2026-04-22T...",
      "pending_count": 3 },
    { "slug": "platform.web", ... },
    { "slug": "platform.api", ... },
    { "slug": "platform.sdk", "current_version": "2.3.0", ... }
  ],
  "tenants": [
    {
      "tenant_id": "...", "name": "MAXINA",
      "surfaces": [
        { "slug": "tenant.maxina.desktop", "surface": "desktop",
          "current_version": "1.4.2", "current_channel": "stable",
          "min_platform_version": ">=2.3.0",
          "compatibility": "ok",       // 'ok' | 'behind' | 'breaking'
          "pending_count": 5 },
        { "slug": "tenant.maxina.ios", ... },
        { "slug": "tenant.maxina.android", ... }
      ]
    }
  ]
}
```

`compatibility` is computed server-side from `current_version` of
`platform.sdk` vs each tenant surface's `min_platform_version` /
`target_platform_version`. The overview screen never has to do semver math.

---

## 5. OASIS events

Following the existing `oasis_events` pattern (see DATABASE_SCHEMA.md):

- `release.component.registered`
- `release.published` — payload: `{component_slug, version, channel, released_by}`
- `release.rolled_back` — payload includes `rollback_of`
- `release.backlog.item.created` / `.updated` / `.dropped`
- `release.compatibility.broken` — emitted when a platform.sdk release moves a
  tenant surface from `ok` → `breaking`. This is the trigger for the orange
  badge in Command Hub.
- `release.changelog.published` — emitted when a tenant_admin promotes a
  changelog draft to `stable`. Triggers the propagation to App Store / Play
  Store / in-app `/changelog`.

---

## 6. UI surfaces — where each role finds it

Three distinct surfaces, all driven by the same data model + API.

### 6.1 Command Hub — `/dev/releases` (Developer + Exafy super-admin)

**Lives in:** `vitana-v1` at `/dev/releases` (the in-app Command Hub —
resolved from § 9 open question; access is gated per `role-cleanup-decisions.md` § Q1
to Developer + `isExafyAdmin` only).

**Page file (new):** `src/pages/dev/DevReleases.tsx`
**Imports from:** existing `DevLayout.tsx` shell

System-wide release matrix. Read/write across all tenants and all platform
components.

```
┌─ /dev/releases ────────────────────────────────────────────────┐
│                                                                │
│  PLATFORM                                                      │
│  ┌──────────────┬─────────┬──────────┬───────────┬──────────┐  │
│  │ Component    │ Version │ Channel  │ Released  │ Pending  │  │
│  ├──────────────┼─────────┼──────────┼───────────┼──────────┤  │
│  │ Command Hub  │ 2.3.4   │ stable   │ 4d ago    │ 3        │  │
│  │ Gateway/API  │ 1.8.1   │ stable   │ 2d ago    │ 7        │  │
│  │ SDK          │ 2.3.0   │ stable   │ 4d ago    │ 1        │  │
│  │ vitanaland.. │ 1.2.0   │ stable   │ 1w ago    │ 0        │  │
│  └──────────────┴─────────┴──────────┴───────────┴──────────┘  │
│                                                                │
│  TENANTS                                                       │
│  ┌─────────┬──────────────┬──────────┬──────────┬──────────┐   │
│  │ Tenant  │ Desktop      │ iOS      │ Android  │ Pending  │   │
│  ├─────────┼──────────────┼──────────┼──────────┼──────────┤   │
│  │ MAXINA  │ 1.4.2 ✓      │ 1.4.0 ✓  │ 1.3.9 ⚠  │ 5/3/4    │   │
│  └─────────┴──────────────┴──────────┴──────────┴──────────┘   │
│                                                                │
│  [Filter: channel ▾]  [Filter: tenant ▾]  [+ Backlog item]    │
└────────────────────────────────────────────────────────────────┘
```

Click any row → drawer with full release history + open backlog items for
that component.

### 6.2 Command Hub — `/dev/docs/backlog` (Developer + Exafy super-admin)

**Lives in:** `vitana-v1` extending the existing `/dev/docs` hub
(`DevDocs.tsx` already supports sub-tabs `/dev/docs/catalogs`,
`/dev/docs/screen-lists`, `/dev/docs/frontpages`, `/dev/docs/role-views` —
adding `/dev/docs/backlog` follows the existing pattern).

**Purpose:** markdown doc viewer that renders the `docs/*.md` spec/decision
files directly in-app, so a developer working in Command Hub can read the
rationale without leaving the surface or context-switching to GitHub.

**Files surfaced:**
- `docs/release-backlog-overview-screen.md` — this spec's frontend half
- `docs/feature-catalog-by-role.md` — feature inventory by role
- `docs/role-cleanup-decisions.md` — Q1–Q7 decisions
- `vitana-platform/specs/release-backlog-overview.md` — canonical spec (proxied via gateway)

**Implementation approach:** the page reads a curated list of doc paths from
config, fetches the markdown via the existing gateway (or directly from the
repo if served statically), and renders with the existing markdown component
already used in the app. No CMS, no duplication of content — the repo files
are the source of truth.

### 6.3 Admin (tenant) — `/admin/releases` (Tenant Admin)

**Lives in:** `vitana-v1` at `/admin/releases` — under the tenant Admin pages
shell, gated by `<ProtectedRoute requiredRole="admin">` and scoped to the
caller's tenant.

**Page file (new):** `src/pages/admin/Releases.tsx`

**Three tabs under one route:**

| Tab | Path | Purpose |
|-----|------|---------|
| **Overview** | `/admin/releases` (default) | Read-only matrix — platform versions MAXINA depends on + MAXINA's surfaces (Desktop / iOS / Android) + compatibility badges |
| **Changelog** | `/admin/releases/changelog` | Authoring UI — markdown editor for the `release_history.changelog` field, channel selector, version picker. On stable publish, content propagates to App Store / Play Store / in-app `/changelog` |
| **Backlog** | `/admin/releases/backlog` | CRUD on `release_backlog_items` for MAXINA's components — title, summary, status, target version, optional VTID link |

Tab switching is shallow (no full-page reload). All three tabs hit the same
endpoints — the gateway scopes results to the caller's tenant.

The full layout details for each tab live in
`vitana-v1/docs/release-backlog-overview-screen.md`.

---

## 7. RBAC matrix

Aligned to the canonical 6-role model + Exafy super-admin (per
`role-cleanup-decisions.md`):

| Role | `/dev/releases` | `/dev/docs/backlog` | `/admin/releases` Overview | `/admin/releases` Changelog | `/admin/releases` Backlog | Public `/changelog` |
|------|-----------------|---------------------|----------------------------|------------------------------|---------------------------|---------------------|
| Community | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ read |
| Patient | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ read |
| Professional | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ read |
| Staff | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ read |
| Admin (tenant) | ❌ | ❌ | ✅ read own | ✅ author own | ✅ CRUD own | ✅ read |
| Developer | ✅ full | ✅ read | ✅ read all | ✅ author all | ✅ CRUD all | ✅ read |
| Exafy super-admin (`isExafyAdmin`) | ✅ full | ✅ read | ✅ full | ✅ full | ✅ full | ✅ read |

Mobile devices: `useIsMobile()` forces role to `community` (per Q3), so all
release-tracking surfaces are desktop-only — including for tenant admins.

---

## 8. Tenant-side widget contract (consumed by vitana-v1)

The gateway scopes the `/api/v1/releases/overview` response based on the
caller's role/tenant. From the frontend's perspective there is no special
tenant-only endpoint — the API just returns less data when called with a
tenant_admin token:

- the **full platform** section (read-only — tenant needs to see what they
  depend on)
- only **their tenant** under `tenants[]`
- backlog items filtered to `visibility IN ('tenant','public')`

This keeps the tenant view a strict subset of the Hub view, with no second
data path to maintain.

---

## 9. Open questions / decisions needed

1. **VTID linkage direction.** Do backlog items live here and *reference*
   VTIDs, or should every backlog item *be* a VTID with a `release_target`
   field added to `vtid_ledger`? Current spec: separate table, optional
   `vtid` link. Cleaner separation, mild duplication.

2. **SDK versioning model.** Is there a single `platform.sdk` version that
   tenants pin to, or does each platform component (api, hub, web) have an
   independent contract? Spec assumes single SDK version for simplicity —
   confirm with platform team.

3. **Channel promotion flow.** Should promoting `beta → stable` be a
   dedicated endpoint (`POST /releases/components/:id/promote`) or just a
   `PATCH` on `current_channel`? Promote endpoint reads better in audit logs
   and emits a clean `release.promoted` OASIS event.

4. **Public changelog component allowlist.** Confirm which components are
   public-facing — likely: Command Hub no, MAXINA iOS/Android/Desktop yes,
   vitanaland.com yes. Drives what `/api/v1/releases/changelog/public`
   returns.

5. ~~**Where does Command Hub frontend actually live?**~~ **RESOLVED:**
   Command Hub UI lives in `vitana-v1` at `/dev/*` (in-app, gated to
   Developer + Exafy super-admin per Q1 decision). Both `/dev/releases`
   and `/dev/docs/backlog` are added as sub-routes.

6. **App Store / Play Store changelog propagation mechanism.** When a
   tenant_admin publishes a stable changelog via `/admin/releases/changelog`,
   does it auto-push to App Store Connect / Play Console (via API), or does
   it emit an OASIS event that a separate worker picks up? Worker pattern
   is more decoupled but adds latency; API pattern is direct but couples
   tenant_admin actions to external service uptime. Recommend worker.

---

## 10. Phasing

- **Phase 1 (this branch, docs only):** specs land on both repos, review.
- **Phase 2:** add tables + migration + DATABASE_SCHEMA.md update; wire
  `GET /releases/overview` only (read-only, seeded data).
- **Phase 3a:** Command Hub `/dev/releases` matrix screen consuming the overview endpoint.
- **Phase 3b:** Command Hub `/dev/docs/backlog` markdown-viewer sub-tab (extends existing `DevDocs.tsx`).
- **Phase 4:** write endpoints + backlog CRUD; `/admin/releases` 3-tab screen in vitana-v1.
- **Phase 5:** changelog publishing pipeline + App Store / Play Store propagation worker; public `/changelog` route.
- **Phase 6:** OASIS events fully wired; rollback flow.
