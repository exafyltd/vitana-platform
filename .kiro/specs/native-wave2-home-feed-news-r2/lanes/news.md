---
lane: news
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/news/**
  - apps/mobile/app/(app)/post/**
  - apps/mobile/src/screens/news/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/news/**
  - apps/mobile/maestro/news/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/newsNative.json
  - docs/validation/**
updated: 2026-11-01T00:05Z
---
# News / post reader port — `NEWS.DETAIL /news/:id`, `/post/:source/:id`; owns the NewsArticleCard native twin
Plan: `.kiro/specs/native-wave2-home-feed-news-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: news -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 2 ledger rows under `"lane": "home-feed"` for this lane, both
`not_started` — `NEWS.DETAIL /news/:id` and the exclusion row `/post/:source/:id`. Web sources
`src/pages/NewsArticleDetail.tsx` (230 lines, route `src/App.tsx:1001-1008`), `src/pages/PostDetail.tsx` (158 lines,
route `src/App.tsx:1010-1016`); shared card `src/components/crossover/NewsArticleCard.tsx` (187 lines).
**Goal.** Port the two reader screens to native on the N3 shell at 1:1 mobile-web parity, and build the
`NewsArticleCard` native twin that Home's feed consumes through a port (design decision 3), so the card has exactly
one owner. Full-screen reader + single post/video deep-link target; `<video>`→`expo-video`, images→`expo-image`.
Flips both parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for `/news/:id` and `/post/:source/:id`; mobile-web parity; `@vitana/core`-only web bridge; the
  card twin shared via a port (no duplicate owner).
- `npm run typecheck`, `npm test` (article loaded/not-found/error; post loaded/deleted/error; card image fallback;
  deep-link resolves), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with both
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's read-only spec)
  and `plan-sparring.md` (copy of the plan's sparring record).
- **Device-runtime parity (task 7)** — Maestro + sim/emulator screenshots + parity vs 390×844 staging — is deferred
  to G1 as `next_actor: owner`; not a merge blocker for the port, recorded in this log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 2 rows), `packages/core/manifest.json`
+ closure + `src/**` (only the re-exports this lane adds), and the DE-first i18n shard are shared by row/line with the
other two lanes; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-11-01T00:05Z · kiro-exafyltd-202611010001-8e5e · ready
Lane created with the plan (re-plan of `native-wave2-home-feed-news/news`, PR #4273).
