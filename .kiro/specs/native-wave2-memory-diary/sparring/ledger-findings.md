# Ledger findings — native Wave 2 Memory + Diary cluster

READ-ONLY investigation. Authoritative source: `apps/mobile/parity/ledger.json` at
`vitana-v1` **origin/main** (fetched `git fetch --prune origin`, read via
`git show origin/main:apps/mobile/parity/ledger.json`). Ledger **version 2**,
**435 rows** total, 4 `native_only`, 15 `shell`. Every row below was verified
against that live file.

---

## 1. Selected rows (the cluster)

All memory/diary destinations live in the ledger parity-lane `"memory-diary"`.
There are **exactly 7 rows** in that lane — no `add-memory`, `what-vitana-knows`,
`photo-diary` or `diary-audio` row exists as a separate ledger row; those are
sub-features/overlays reached inside the 7 screens below. (The only other
`audio`/`recall`/`timeline` hits in the ledger are `/autopilot/audiobook`, a
different cluster.)

Every row is identical in shape: `kind: "screen"`, `source: "registry"`,
`scope: "in"`, `lane: "memory-diary"`, `status: "not_started"`, `exception: null`,
`owner: null`, `last_parity_check: null`.

### MEMORY cluster — 4 rows (web path prefix `/memory`)

| # | key | web_path | source | kind | scope | status |
|---|-----|----------|--------|------|-------|--------|
| 1 | `MEMORY.OVERVIEW` | `/memory` | registry | screen | in | not_started |
| 2 | `MEMORY.TIMELINE` | `/memory/timeline` | registry | screen | in | not_started |
| 3 | `MEMORY.RECALL` | `/memory/recall` | registry | screen | in | not_started |
| 4 | `MEMORY.PERMISSIONS` | `/memory/permissions` | registry | screen | in | not_started |

### DIARY cluster — 3 rows (web path prefix `/daily-diary`)

| # | key | web_path | source | kind | scope | status |
|---|-----|----------|--------|------|-------|--------|
| 5 | `MEMORY.DAILY_DIARY` | `/daily-diary` | registry | screen | in | not_started |
| 6 | `MEMORY.DIARY` | `/daily-diary?tab=health` | registry | screen | in | not_started |
| 7 | `MEMORY.DIARY_BUGS` | `/daily-diary?tab=bugs` | registry | screen | in | not_started |

> Note on rows 5–7: all three resolve to the SAME web page component
> (`src/pages/MobileDailyDiary.tsx`); `?tab=health` / `?tab=bugs` only pick the
> `MobileModePill` mode inside it (`searchParams.get("tab")`, default `health`).
> The native port is one route that reads the `tab` query param — the three rows
> flip to `native` together.

**Counts:** memory = 4, diary = 3, cluster total = **7 of 435**.

---

## 2. Web source files backing each row

Routes read from `vitana-v1 src/App.tsx`:

| Row(s) | Web route (App.tsx line) | Page component | Lines |
|--------|--------------------------|----------------|-------|
| `MEMORY.OVERVIEW` | `App.tsx:1605` `/memory` → `<Memory/>` | `src/pages/Memory.tsx` | 124 |
| `MEMORY.TIMELINE` | `App.tsx:1610` `/memory/timeline` → `<Timeline/>` | `src/pages/memory/Timeline.tsx` | 66 |
| `MEMORY.RECALL` | `App.tsx:1620` `/memory/recall` → `<Recall/>` | `src/pages/memory/Recall.tsx` | 350 |
| `MEMORY.PERMISSIONS` | `App.tsx:1625` `/memory/permissions` → `<MemoryPermissions/>` | `src/pages/memory/Permissions.tsx` | 62 |
| `MEMORY.DAILY_DIARY` / `MEMORY.DIARY` / `MEMORY.DIARY_BUGS` | `App.tsx:1120` `/daily-diary` → `<MobileDailyDiary/>` | `src/pages/MobileDailyDiary.tsx` | 193 |

Related non-row route: `App.tsx:1615` `/memory/diary` → `<DiaryRouter/>`
(`src/pages/memory/Diary.tsx`, 381 lines). On mobile, `/memory/diary`
redirects to `/daily-diary` (App.tsx:720-727); `MobileDailyDiary` itself
redirects to `/memory/diary` on desktop. For the native (phone) app only the
`MobileDailyDiary` path matters; `Diary.tsx` is the desktop hub and is NOT a
cluster row.

### Components each screen pulls in

**Memory overview (`Memory.tsx`)** composes: `AddMemoryDialog`,
`MemoryCategoryGrid`, `WhatVitanaKnows`, `MemoryTimelineTab`,
`MemoryEducationTab`, `IndexWeekStory`, `RoutinesCard` (all `src/components/memory/**`).

**Timeline (`Timeline.tsx`)** → `TimelineBody` (`src/components/timeline/**`:
`TimelineBody`, `IndexSpotlightCard`, `TimelineRows`, `TimelineDetailSheet`,
`timeline-meta`).

**Recall (`Recall.tsx`)** → `RecallMasterActionPopup`, `NewsCard`,
`MotivationalBanner`. Body is **mock/static** arrays; the Spotlight path shows
an honest empty state (`SpotlightEmpty`). No live data read on this screen.

**Permissions (`Permissions.tsx`)** → `LearningSwitches`, `UsageDataCard`
(`src/components/memory/learning/**`).

**Daily Diary (`MobileDailyDiary.tsx`)** → `UnifiedCaptureCard`
(`src/components/capture/`), `TextDiaryEditor`, `PhotoDiaryUploader`,
`DiaryEntryList` (`src/components/diary/`), `FeedbackReportList`
(`src/components/feedback/` → `MyTicketsList` in `src/components/support/`).

---

## 3. CLASS-A vs CLASS-B determination (premise verified by reading imports)

Rule: a web module is **class-B** (re-implemented natively, NOT core-extracted)
if it imports `@/integrations/supabase/client` or `@/lib/community-gateway`
directly or transitively. `@/lib/memory-api`, `@/lib/memory-learning-api`,
`@/lib/timeline-api` and `@/lib/diary-index-sync` all import
`@/lib/community-gateway` (verified: `memory-api.ts:8`, `diary-index-sync.ts:1`),
so any module importing them at runtime is class-B.

### DIARY cluster modules

| Module | supabase | gateway (via) | Class | Evidence |
|--------|----------|---------------|-------|----------|
| `components/diary/DiaryEntryList.tsx` | yes (`:7`) | `memory-api` (`:9` deleteDiaryEntry) + supabase realtime | **B** | reads/deletes diary rows, realtime channel |
| `components/diary/TextDiaryEditor.tsx` | — | `memory-api` (`:7` saveDiaryEntry) | **B** | one gateway write path (VTID-04390) |
| `components/diary/PhotoDiaryUploader.tsx` | yes (`:6`) | `memory-api` (`:9`) + `diary-index-sync` (`:8`) | **B** | Supabase Storage upload + gateway save |
| `components/capture/UnifiedCaptureCard.tsx` | yes (`:13`) | `memory-api` (`:14`) + `GATEWAY_BASE` (`:30`) + `feedback-ticket` | **B** | MediaRecorder + backend STT + gateway |
| `components/feedback/FeedbackReportList.tsx` → `support/MyTicketsList` | — | gateway (tickets) | **B** | gateway-backed ticket list |
| `components/feedback/FeedbackRecorder.tsx` | yes (`:15`) | `GATEWAY_BASE` (`:21`) + `feedback-ticket` | **B** | bug/UX ticket submit |

**Diary verdict:** every diary data module is **class-B**. Confirms the task
premise — photo uploads use **Supabase Storage**, audio capture uses
**MediaRecorder + Web Speech / backend STT** on web; native must re-implement
with `expo-image-picker` (photo) and an expo audio recorder + native/back-end STT
(audio). None of these are core-extractable.

### MEMORY cluster modules

| Module | supabase | gateway (via) | Class | Evidence |
|--------|----------|---------------|-------|----------|
| `components/memory/AddMemoryDialog.tsx` | yes (`:11`) | `useKnowledgeBase` → `memory-api` | **B** | add-memory write |
| `components/memory/WhatVitanaKnows.tsx` | yes (`:12`) | `GATEWAY_API_URL` (`:18`) + `useQuery` | **B** | self-awareness summary read |
| `components/memory/MemoryCategoryGrid.tsx` | — | `useMemoryMetadata` + `memory-api` (`gardenCategoryKey`) | **B** | garden categories |
| `components/memory/CategoryDetailDialog.tsx` | — | `useKnowledgeBase` + `memory-api` | **B** | garden entry CRUD |
| `hooks/useKnowledgeBase.ts` | — | `memory-api` (`:14`) → gateway `/api/v1/memory/garden` | **B** | canonical memory store |
| `components/memory/learning/LearningSwitches.tsx` | — | `memory-learning-api` (`:12`) | **B** | learning prefs read/write |
| `components/memory/learning/UsageDataCard.tsx` | — | `memory-learning-api` (`:23` exportUsageData) | **B** | usage count/export/delete |
| `components/memory/learning/RoutinesCard.tsx` / `IndexWeekStory.tsx` | — | `memory-learning-api` / `timeline-api` | **B** | routines + index-week |
| `components/timeline/*` (TimelineBody, IndexSpotlightCard, TimelineRows, TimelineDetailSheet) | — | `timeline-api` → gateway `/api/v1/timeline` | **B** | the whole timeline screen |

**Memory verdict:** every memory data path is **class-B**. The Recall screen is
the one exception — its body is static mock data + an empty state, so it ports
as a pure presentational screen (no data module) but is still re-authored
natively, not core-extracted.

### Class-A surface (pure → @vitana/core re-export candidates)

There is **no clean full-module class-A re-export** in either cluster: every
screen's runtime data path is class-B. The only genuinely pure logic is embedded
helpers that native **mirrors**, not re-exports, because they still pull web-only
deps (`lucide-react`, `@/hooks/useVitanaIndex`):

- `components/timeline/timeline-meta.tsx` — pillar/catalog icon + text maps
  (type-only imports from `timeline-api`).
- `components/memory/learning/routine-text.ts` — routine phrasing (type-only
  import from `memory-learning-api`).
- `lib/memory-api.gardenCategoryKey` and `lib/diary-index-sync.formatIndexDelta`
  are pure functions, but they live INSIDE class-B modules (both import
  `community-gateway`), so they are re-derived natively, not re-exported.

**Conclusion for the spec:** treat the whole cluster as class-B native
re-implementation against the gateway/supabase, reusing `@vitana/core`
gateway helpers (`createGatewayFetch`/`gatewayJson`, already wired in
`apps/mobile/src/auth/gateway.ts`) and the native supabase client
(`@supabase/supabase-js`, already a native dependency). DE-first i18n keys and
timeline/pillar text are mirrored from the pure helpers above.

---

## 4. Lane partition — DISJOINT, 0 overlap / 0 orphan

The ledger carries one parity-lane (`memory-diary`). For the **work lanes** this
plan splits it into two disjoint build lanes by cluster. The web path prefixes
(`/memory*` vs `/daily-diary*`), the native route subtrees and the native screen
subtrees are all disjoint, so the split is clean.

Diary is NOT split further: its 3 rows are one screen with a tab param, and its
native files (photo/text/audio capture + entry list) share one subtree — a
sub-split would not keep file subtrees disjoint.

### Lane `memory` — 4 rows

- Rows: `MEMORY.OVERVIEW` (`/memory`), `MEMORY.TIMELINE` (`/memory/timeline`),
  `MEMORY.RECALL` (`/memory/recall`), `MEMORY.PERMISSIONS` (`/memory/permissions`).
- Native route files (new, under `apps/mobile/app/(app)/memory/`):
  - `app/(app)/memory/index.tsx` → `/memory` (overview hub)
  - `app/(app)/memory/timeline.tsx` → `/memory/timeline`
  - `app/(app)/memory/recall.tsx` → `/memory/recall`
  - `app/(app)/memory/permissions.tsx` → `/memory/permissions`
  - (optional `app/(app)/memory/_layout.tsx` if a stack layout is needed)
- Native screen subtree (new): `apps/mobile/src/screens/memory/**`
  (MemoryOverview, MemoryTimeline, MemoryRecall, MemoryPermissions + the memory
  data hooks/components re-implemented class-B).
- `depends_on`: gateway `/api/v1/memory/garden`, `/api/v1/memory/*`
  self-awareness summary, `/api/v1/timeline` (via `@vitana/core` gateway helper);
  supabase client (already present). No dep on the diary lane.

### Lane `diary` — 3 rows

- Rows: `MEMORY.DAILY_DIARY` (`/daily-diary`), `MEMORY.DIARY`
  (`/daily-diary?tab=health`), `MEMORY.DIARY_BUGS` (`/daily-diary?tab=bugs`).
- Native route file (new): `apps/mobile/app/(app)/daily-diary/index.tsx` →
  `/daily-diary` (under the `app/(app)/daily-diary/**` subtree), reading the
  `tab` query param (health|bugs) to pick the mode. (Single route; all 3 rows
  flip together.)
- Native screen subtree (new): `apps/mobile/src/screens/diary/**`
  (DailyDiaryScreen + UnifiedCapture, TextDiaryEditor, PhotoDiaryUploader,
  DiaryEntryList, FeedbackReportList re-implemented class-B).
- `depends_on`: gateway diary write path (`saveDiaryEntry`
  `/api/v1/...memory/diary`), `deleteDiaryEntry`, feedback-ticket endpoints,
  timeline/Vitana-Index sync; Supabase Storage (photo upload) + Supabase diary
  rows + realtime; **new native deps** `expo-image-picker` and an expo audio
  recorder (`expo-audio`/`expo-av`) + native/back-end STT — NOT yet in
  `apps/mobile/package.json`. No dep on the memory lane.

**Partition check:** 4 (memory) + 3 (diary) = 7 = every selected row, each in
exactly one lane. Native route subtrees (`app/(app)/memory/**` vs
`app/(app)/daily-diary/**`) and screen subtrees (`src/screens/memory/**` vs
`src/screens/diary/**`) are disjoint. **0 overlap, 0 orphan — confirmed.**

> Note: the native `/daily-diary` route is `app/(app)/daily-diary/index.tsx`
> (under the `app/(app)/daily-diary/**` subtree), outside the `memory/` folder,
> so even though both clusters share the ledger prefix mapping, their native file
> trees do not collide.

---

## 5. Scope confirmation — ports only, status flips only

Verified against `vitana-v1 src/App.tsx`, `src/navigation/registry/screens.json`
usage and `scripts/native/parity-scope.json`:

- **No new web routes.** All 5 distinct web routes (`/memory`, `/memory/timeline`,
  `/memory/recall`, `/memory/permissions`, `/daily-diary`) already exist in
  `App.tsx`. This is a native port of existing screens.
- **No `App.tsx` changes.** Web routing is untouched.
- **No `screens.json` / `exclusions.json` changes.** The destinations are already
  registry screens (`source: "registry"` on every row); the native app resolves
  them. `scripts/native/parity-scope.json` already maps `/memory` and
  `/daily-diary` to lane `memory-diary` (`lane_rules` lines 101-102) — no scope
  edit needed.
- **Ledger = status flips only.** The 7 rows go `not_started → in_progress →
  native` as each lane lands (hand-edited `status`/`owner`/`last_parity_check`
  per the ledger `_comment`; `--sync` adds rows, it does not set status). Adding
  the concrete native route files makes Expo Router rank them above the
  `app/(app)/[...path].tsx` resolver automatically.
- **Web file changes limited to:** (a) a DE-first i18n key only if a native
  screen needs a string the web shards don't already have (DE shard first, then
  mirror to `en/` — most strings already exist under `screens.memory.*`,
  `timeline.*`, `memoryLearning.*`, `diary.*`, `spotlightMember.memory.*`), and
  (b) at most a `@vitana/core` re-export line IF a pure helper is promoted to
  core — but §3 found no clean full-module class-A candidate, so even this is
  likely unnecessary. No web component/logic rewrite.

---

## Appendix — commands run (read-only)

- `git -C c:\Users\dstev\vitana-v1 fetch --prune origin`
- `git -C c:\Users\dstev\vitana-v1 show origin/main:apps/mobile/parity/ledger.json`
  → parsed: version 2, 435 rows, 7 in `memory-diary` lane.
- Read: `src/App.tsx` (routes), all 5 cluster page components, diary/capture/
  feedback/memory/timeline components, `apps/mobile/package.json`,
  `apps/mobile/app/(app)/[...path].tsx`, `apps/mobile/src/auth/gateway.ts`,
  `scripts/native/parity-scope.json`.
