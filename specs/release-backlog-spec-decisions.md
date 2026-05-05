# Release Backlog & Versioning — Spec Decisions (P1–P5 + F1)

**Status:** Approved (decisions captured during spec walkthrough)
**Branch:** `claude/backlog-versioning-structure-7frZn`
**Companion specs:**
- `specs/release-backlog-overview.md` (canonical platform spec — § 9 questions resolved by this doc)
- `vitana-v1/docs/release-backlog-overview-screen.md` (frontend spec — § 10 question F1 resolved by this doc)
- `vitana-v1/docs/role-cleanup-decisions.md` (related Q1–Q7 walkthrough — role model, security, cleanup)

This document records the decisions made on the open spec questions surfaced
in the original walkthrough. Each decision below is now the canonical answer
and supersedes the corresponding open question in the spec docs.

---

## P1 — VTID linkage

**Decision:** Separate `release_backlog_items` table with optional `vtid` column.
For items where `vtid` is set, the API returns `vtid_ledger.status` (read-through);
the local `status` field is only writable when `vtid IS NULL`.

**Why:** the two backlog audiences have fundamentally different work types.
Tenant admins' release work (App Store screenshots, public changelog copy,
app-store version planning) isn't engineering execution and shouldn't need a
VTID. Developers' release work usually IS a VTID. Keeping them in separate
tables respects that split. The read-through status for VTID-linked items
eliminates the drift problem at zero schema cost.

**Implementation impact:**
- Schema: as currently specified in `release-backlog-overview.md` § 3
- API: `GET /api/v1/releases/backlog` returns each item with `effective_status`
  computed server-side (`vtid_ledger.status` if `vtid IS NOT NULL`, else local `status`)
- API: `PATCH /api/v1/releases/backlog/:id` rejects writes to `status` when `vtid IS NOT NULL`
  with `409 Conflict — edit the linked VTID instead`

---

## P2 — Platform versioning model

**Decision:** Single `platform.sdk` version is the public contract. Tenants pin
against SDK only. Internal versions of `platform.command-hub`, `platform.api`,
and `platform.web` are platform-team-internal concerns and not exposed in the
tenant compatibility model.

**Why:** matches how Stripe/Twilio/etc. expose versioning — one public SDK
number, the platform's own CI keeps internal components in lockstep. Per-component
pinning would force tenant teams to track 4 numbers and understand platform
internals; 90% of the time they all move together anyway. The OASIS event
`release.compatibility.broken` covers the rare internal-mismatch case as a
Phase 6 hardening, not a Phase 1 schema decision.

**Implementation impact:**
- Schema: `release_components.min_platform_version` and `target_platform_version`
  refer specifically to `platform.sdk`'s version
- One sentence to be added to `release-backlog-overview.md` § 3 making this explicit
- Compatibility badge logic: simple semver compare between tenant's
  `min_platform_version` and the live `platform.sdk` row

---

## P3 — Channel promotion endpoint

**Decision:** Dedicated `POST /api/v1/releases/components/:id/promote` endpoint.
PATCH stays for everything else (metadata, version pins, display name).

**Endpoint shape:**
```jsonc
POST /api/v1/releases/components/:id/promote
{ "from": "beta", "to": "stable", "release_id": "..." }
```

**Why:** channel promotion is the action the App Store/Play Store worker (P5)
listens for. It deserves its own endpoint, its own OASIS event, and its own
RBAC scope:

1. **Audit clarity** — `release.promoted` events are easy to filter for
   compliance / postmortem (distinct from `release.published` for first-publish)
2. **Safety** — server enforces `internal → beta → stable` order; can't skip
   or regress accidentally (rejects with `400 invalid promotion path`)
3. **Clean RBAC** — `release_manager` capability gets `promote`, `developer`
   role gets full PATCH; no need for field-level guards

**Implementation impact:**
- Add `POST /promote` to gateway routes alongside existing CRUD
- New OASIS event: `release.promoted` with payload `{component_slug, from_channel, to_channel, release_id, promoted_by}`
- The release-publisher worker (P5) subscribes to this event

---

## P4 — Public changelog component allowlist

**Decision:** `public_changelog BOOLEAN NOT NULL DEFAULT FALSE` column on
`release_components`, with surface-derived seed defaults:

| Surface | `public_changelog` default |
|---------|---------------------------|
| `desktop` | `TRUE` |
| `ios` | `TRUE` |
| `android` | `TRUE` |
| `web` | `TRUE` |
| `command_hub` | `FALSE` |
| `api` | `FALSE` |
| `sdk` | `FALSE` |

**Why:** zero-friction defaults give the right behavior for every current
component, and the column exists as an explicit escape hatch for future
edge cases (e.g., MAXINA wants to soft-launch iOS by suppressing it from the
public changelog for one release).

**Implementation impact:**
- Schema: add column to `release_components` with the above default + seed values
- `GET /api/v1/releases/changelog/public` filters: `WHERE channel='stable' AND public_changelog=TRUE`
- Tenant admin UI exposes a "Show on public changelog" toggle per surface (default reflects schema)

---

## P5 — App Store / Play Store propagation mechanism

**Decision:** Decoupled worker (`services/release-publisher`) subscribing to
`release.promoted` OASIS events. Direct API calls from the gateway are explicitly
rejected.

**Why:**
1. **App Store / Play Store have built-in review delays** (hours to days) —
   synchronous push isn't a UX feature; the user's "promote" success comes
   from the OASIS event being recorded, not from Apple/Google ack
2. **Decoupling matches existing platform architecture** — there's already
   `services/autopilot-worker`, `services/deploy-watcher`, `services/worker-runner`.
   Adding `services/release-publisher` fits the pattern
3. **Future propagation targets are free** — vitanaland.com cache invalidation,
   Slack release announcements, internal email digest — they all become
   additional subscribers to the same `release.promoted` event without
   touching `/promote`

**Implementation outline:**
- New service: `services/release-publisher`
- Subscribes to `release.promoted` events where `target.surface IN ('ios','android','web')`
- iOS path: App Store Connect API → update "What's New" for the next pending version
- Android path: Play Developer API → update release notes for the next track
- Web path: invalidate vitanaland.com edge cache for `/changelog`
- Failure handling: retry with exponential backoff; dead-letter to OASIS as
  `release.publish.failed` event after N retries
- Visible in Command Hub `/dev/releases` as a yellow badge on affected release rows
- Secrets isolated to this service (App Store Connect token, Play Console
  service account JSON) — not exposed to gateway

---

## F1 — `/admin/releases` nav placement

**Decision:** Top-level item in the MAXINA admin sidebar, immediately after
`System` and before `Navigator`. In sectioned sidebar config, place it in
the "Operations" / "Platform" group with `System`.

**Why:** Releases is operationally important (3-tab structure means tenant
admins hit it weekly — especially Changelog when each app version ships).
Burying it under `/admin/system/releases` would frustrate that workflow.
Top-level placement keeps it discoverable; pairing it next to System keeps
the operational/system grouping cohesive.

**Implementation impact:**
- `src/pages/admin/Releases.tsx` (new) handles all three tabs
- Nav config: add a `Releases` entry adjacent to `System` in `AdminSidebar`
- Routes: `/admin/releases` (Overview), `/admin/releases/changelog`, `/admin/releases/backlog`
- All three tabs share `<ProtectedRoute requiredRole="admin">` and the
  tenant-scoping comes from the gateway (per the overview endpoint design)

---

## Tickets to open (Phase 2+ implementation work)

The 8 cleanup tickets from `role-cleanup-decisions.md` are independent of
this set — they fix existing role/cleanup issues. The tickets below are the
**implementation work** for the release-backlog system itself, ordered by
phase per `release-backlog-overview.md` § 10.

### Phase 2 — Schema & read-only API

| # | Title | Repo |
|---|-------|------|
| R1 | Add `release_components`, `release_history`, `release_backlog_items` tables + migration + DATABASE_SCHEMA.md update | vitana-platform |
| R2 | Implement `GET /api/v1/releases/overview` (read-only, role-aware) | vitana-platform |
| R3 | Seed `release_components` with current MAXINA + platform components, set `public_changelog` defaults per P4 | vitana-platform |

### Phase 3a — Command Hub matrix view

| # | Title | Repo |
|---|-------|------|
| R4 | Add `src/types/releases.ts` with the wire types from spec § 6 | vitana-v1 |
| R5 | Build `src/pages/dev/DevReleases.tsx` consuming `/releases/overview` | vitana-v1 |
| R6 | Add `Releases` entry to Command Hub nav (top-level, alongside Routines) | vitana-v1 |

### Phase 3b — Command Hub doc viewer

| # | Title | Repo |
|---|-------|------|
| R7 | Add `/dev/docs/backlog` sub-tab to `DevDocs.tsx`; curate doc list in `src/config/devDocs.ts` | vitana-v1 |
| R8 | Add gateway proxy `GET /api/v1/docs/specs/:filename` for serving platform-repo docs | vitana-platform |

### Phase 4 — Tenant admin 3-tab screen + write endpoints

| # | Title | Repo |
|---|-------|------|
| R9 | Implement remaining gateway endpoints: `POST /releases/components`, `PATCH /:id`, `POST /history`, backlog CRUD, `POST /:id/promote` | vitana-platform |
| R10 | Build `src/pages/admin/Releases.tsx` with Overview / Changelog / Backlog tabs | vitana-v1 |
| R11 | Add Releases entry to MAXINA admin sidebar (per F1: top-level, adjacent to System) | vitana-v1 |
| R12 | Implement read-through `effective_status` for VTID-linked backlog items per P1 | vitana-platform |

### Phase 5 — Publisher worker + public changelog

| # | Title | Repo |
|---|-------|------|
| R13 | Build `services/release-publisher` subscribing to `release.promoted` events | vitana-platform |
| R14 | Wire App Store Connect API push for iOS surface | vitana-platform |
| R15 | Wire Play Developer API push for Android surface | vitana-platform |
| R16 | Wire vitanaland.com edge cache invalidation for web surface | vitana-platform |
| R17 | Implement `GET /api/v1/releases/changelog/public` (no auth, filtered by `public_changelog=TRUE`) | vitana-platform |
| R18 | Build public `/changelog` route in MAXINA app | vitana-v1 |

### Phase 6 — Hardening

| # | Title | Repo |
|---|-------|------|
| R19 | Wire all OASIS events: `release.component.registered`, `release.published`, `release.promoted`, `release.rolled_back`, `release.backlog.item.created/updated/dropped`, `release.compatibility.broken`, `release.changelog.published`, `release.publish.failed` | vitana-platform |
| R20 | Implement rollback flow (`rollback_of` references) | vitana-platform |
