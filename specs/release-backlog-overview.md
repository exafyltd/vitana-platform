# Release Backlog & Versioning Overview

**Status:** Draft
**Branch:** `claude/backlog-versioning-structure-7frZn`
**Companion spec:** `vitana-v1/docs/release-backlog-overview-screen.md`
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
       ├─ iOS                        — app version + min platform version
       └─ Android                    — app version + min platform version
  └─ <future tenant>
       └─ ...
```

Each tenant-app row pins a **min platform version** and a **target platform
version**. The overview renders a compatibility badge per cell (`✓` / `⚠ behind` / `✗ breaking`).

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

Append-only log of every release event for a component.

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
| `GET` | `/api/v1/releases/components` | List components (filters: `owner`, `tenant_id`, `surface`) | platform_admin, tenant_admin (own tenant only) |
| `GET` | `/api/v1/releases/components/:id` | Component detail incl. last 10 releases | as above |
| `POST` | `/api/v1/releases/components` | Register new component | platform_admin |
| `PATCH` | `/api/v1/releases/components/:id` | Update current version / channel / pins | platform_admin (any), tenant_admin (own tenant rows only) |
| `GET` | `/api/v1/releases/history` | Filter by `component_id`, `channel`, date range | as list |
| `POST` | `/api/v1/releases/history` | Record a release (creates history row + updates `current_*` on component atomically) | platform_admin / tenant_admin (own) |
| `GET` | `/api/v1/releases/backlog` | List backlog items, filterable; tenant role sees only `visibility IN ('tenant','public')` for their components | role-aware |
| `POST` `PATCH` `DELETE` | `/api/v1/releases/backlog/:id` | CRUD backlog items | platform_admin / tenant_admin (own) |
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

---

## 6. Command Hub UI surface

Lives in Command Hub at `Releases` (top-level nav item, same level as
`Routines`). One screen, role-aware.

```
┌─ Releases ─────────────────────────────────────────────────────┐
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

---

## 7. Tenant-side widget contract

`vitana-v1` (MAXINA) renders a compact "My Releases" widget inside its own
tenant admin (see companion spec). It calls
`GET /api/v1/releases/overview` — the gateway scopes the response to the
caller's tenant when the role is `tenant_admin`, returning:

- the **full platform** section (read-only — tenant needs to see what they
  depend on)
- only **their tenant** under `tenants[]`
- backlog items filtered to `visibility IN ('tenant','public')`

This keeps the tenant view a strict subset of the Hub view, with no second
data path to maintain.

---

## 8. Roles & RBAC

| Role | Can see | Can edit |
|------|---------|----------|
| `platform_admin` (Vitanaland) | everything, all channels, internal notes | everything |
| `release_manager` | everything | publish releases, edit backlog, no schema |
| `tenant_admin` (e.g. MAXINA admin) | platform read-only + own tenant + own backlog (`visibility ≥ tenant`) | own tenant components + own backlog |
| `developer` | same as tenant_admin for their tenant; platform read | own backlog items only |
| `qa` | all components, internal+beta channels prominent | flag blockers (status=`blocked`) |
| `end_user` (in MAXINA app) | nothing in Hub; sees only `/api/v1/releases/changelog/public` rendered as in-app changelog | — |

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

4. **Public changelog source of truth.** Render from
   `release_history WHERE channel='stable' AND component IN (public set)` —
   confirm which components are public-facing (probably: Command Hub no,
   MAXINA iOS/Android/Desktop yes, vitanaland.com yes).

5. **Where does Command Hub frontend actually live?** This spec assumes it's
   served from `services/gateway` or a sibling package. If it's a separate
   repo / package, the UI section needs a path correction.

---

## 10. Phasing

- **Phase 1 (this branch, docs only):** specs land on both repos, review.
- **Phase 2:** add tables + migration + DATABASE_SCHEMA.md update; wire
  `GET /releases/overview` only (read-only, seeded data).
- **Phase 3:** Command Hub `Releases` screen consuming the overview endpoint.
- **Phase 4:** write endpoints + backlog CRUD; tenant-side widget in vitana-v1.
- **Phase 5:** OASIS events + public changelog endpoint.
