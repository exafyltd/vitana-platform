---
lane: support-connectors
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/support.tsx
  - apps/mobile/app/(app)/connectors.tsx
  - apps/mobile/app/(app)/settings/connected-apps.tsx
  - apps/mobile/src/screens/support/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/support/**
  - apps/mobile/maestro/support/**
  - apps/mobile/parity/ledger.json
  - src/i18n/*/supportNative.json
  - docs/validation/**
updated: 2026-11-01T00:05Z
---
# Support + connectors port — member `/support` (+ `?tab=`), `/connectors` (+ `?tab=` + SETTINGS.SOCIAL), `/settings/connected-apps`
Plan: `.kiro/specs/native-wave2-profile-settings-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: support-connectors -->` (tasks 1–7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges;
do not start before `vtid:` is set here. depends_on: none — runs in parallel with `profile` and `settings`.
**Measured on the worktree (= origin/main):** 14 ledger rows under `"lane": "profile-settings-support"` for this
lane, all `not_started` → 3 native route files. Support (4 rows, all shape `/support`, one file):
`SETTINGS.SUPPORT /support`, `SETTINGS.SUPPORT_CONTACT /support?tab=contact`,
`SETTINGS.SUPPORT_COMMUNITY /support?tab=community`, `SETTINGS.SUPPORT_FAQ /support?tab=faqs` (web mobile
`src/pages/MobileSupport.tsx`, 819 lines; tabs `normalizeTab` `:43-98`; router `src/App.tsx:715-718`). Connectors
(9 rows, all shape `/connectors`, one file): `CONNECTORS.{AGENT,AI,FITNESS,HEALTH,MEDIA,OTHER,PRODUCTIVITY,SOCIAL}
/connectors?tab=…` + `SETTINGS.SOCIAL /connectors` (web `src/pages/settings/ConnectedApps.tsx`, 2111 lines;
`activeTab` `:105,2180`; route `src/App.tsx:1441-1445`). Plus `SETTINGS.CONNECTED_APPS /settings/connected-apps`
(shape `/settings/connected-apps`; web redirects it to `/connectors`, `src/App.tsx:1451` — its own row/shape, so a
dedicated native file mirroring the redirect). Member-facing only: admin partner-connections
(`PartnerConnections.tsx`/`PartnerConnectionDetail.tsx`, `requiredRole="admin"`) and Commerce connector docs are out
of scope (requirements R0.5). Support/connectors data hooks (`useWearableProviders`, `useSocialPlatforms`, …) and
`MyTicketsList` are class-B and re-implemented natively (plan decision 2 — no core extraction).
**Goal.** Port the member support surface (one file reading `?tab=`: Contact/report, My Tickets, FAQs, Community —
the Contact form POSTs `/api/v1/feedback/tickets`) and the connected-apps directory (one file reading the category
`?tab=`: agent/ai/fitness/health/media/other/productivity/social + connected view, with connect/disconnect and
provider health) to native on the N3 shell at 1:1 mobile-web parity, plus the `/settings/connected-apps` redirect
row. Every submit/connect/disconnect is a write — ports wired, unit tests assert the built request against a MOCKED
gateway and fire nothing (plan decision 5). Flips all 14 rows to `native`.
**Disjointness note.** This lane owns `apps/mobile/app/(app)/support.tsx`, `apps/mobile/app/(app)/connectors.tsx`
and the single file `apps/mobile/app/(app)/settings/connected-apps.tsx` — the only file it creates under the
`settings/` directory, which is otherwise the `settings` lane's; the two lanes share the directory but never a file
(design §1a). No file in two lanes.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the support + connectors surfaces; mobile-web parity; `@vitana/core`-only web bridge; data
  hooks re-implemented natively (no core extraction); member-facing only (admin/partner tooling excluded, R0.5).
- `npm run typecheck`, `npm test` (support each `?tab=` renders; Contact submit builds the feedback-ticket request
  against a mocked gateway and fires nothing; My Tickets loaded/empty; FAQ expand; connectors each category renders —
  8 tabs + connected; connect/disconnect builds the right request mocked; `/settings/connected-apps` resolves to the
  connectors screen), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 14 rows `native` (query variants satisfied by the
  `/support` and `/connectors` base-shape files; `/settings/connected-apps` by its own file) and the routes present
  in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 6)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`, and at G1 it runs only on the isolated test environment (write-heavy cluster — never
  a live backend as the test account).
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 14 rows), `apps/mobile/src/ports/**` +
`apps/mobile/src/navigation/resolve.ts` (shared native infra — only this lane's support/connectors resolver
aliases), and the DE-first i18n shard `src/i18n/*/supportNative.json` are shared by row/line; resolve a merge
conflict by keeping both lanes' rows/keys. This lane does **not** touch `packages/core/**` (no extraction).
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-11-01T00:05Z · kiro-exafyltd-202611010001-7819 · ready
Lane created with the plan (re-plan of `native-wave2-profile-settings/support-connectors`, PR #4278).
