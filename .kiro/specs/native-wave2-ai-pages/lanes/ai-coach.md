---
lane: ai-coach
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/ai/**
  - apps/mobile/src/screens/ai-coach/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/ai-coach/**
  - apps/mobile/maestro/ai-coach/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/aiCoachNative.json
  - docs/validation/**
updated: 2026-10-28T13:17Z
vtid: VTID-05397
---
# AI coach pages port — `/ai`, `/ai/insights`, `/ai/recommendations`, `/ai/daily-summary`, `/ai/companion`
Plan: `.kiro/specs/native-wave2-ai-pages/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: ai-coach -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 5 ledger rows under `"lane": "ai"` for this lane, all `not_started`
— `AI.OVERVIEW /ai`, `AI.INSIGHTS /ai/insights`, `AI.RECOMMENDATIONS /ai/recommendations`,
`AI.DAILY_SUMMARY /ai/daily-summary`, `AI.COMPANION /ai/companion`. Web sources `src/pages/AI.tsx` (192 lines;
lazy-import `src/App.tsx:183`, route `:1323-1327`), `src/pages/ai/Insights.tsx` (217; `:264`, `:1328-1332`),
`src/pages/ai/AIRecommendations.tsx` (218; `:265`, `:1333-1337`), `src/pages/ai/DailySummary.tsx` (128; `:266`,
`:1338-1342`), `src/pages/ai/Companion.tsx` (280; `:267`, `:1343-1347` — the AI coach chat page, renders
`HealthCoachChat`). All five sit under `/ai`, so this lane owns the `app/(app)/ai/**` route subtree end to end.
**Goal.** Port the five AI coach / insight pages to native on the N3 shell at 1:1 mobile-web parity: the overview,
insights and recommendations card stacks (`VCard`s), the daily-summary (`fetchDailyLearnings` /
`useVitanaIndexHistory` re-implemented through the native gateway port), and the companion AI-coach chat
(`HealthCoachChat` natively, chat transport re-implemented over the native gateway). Flips the 5 parity rows to
`native`. The AI data paths here are class B (gateway) and are re-implemented natively, not extracted into core.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the five `/ai` surfaces; mobile-web parity; `@vitana/core`-only web bridge (class-A
  extracted if any, class-B re-implemented natively).
- `npm run typecheck`, `npm test` (each `/ai` page card stack loaded/empty; daily-summary loaded/empty/error;
  companion fake chat thread + send error), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 5 rows `native` and their routes present in
  `apps/mobile/app/`; `node scripts/native/core-closure.mjs --check` green **if** a core re-export was added.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored, pt Brazilian você-form;
  RTL (`ar`) covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 7)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 5 rows), `packages/core/manifest.json`
+ closure + `src/**` + `scripts/native/mobile-ci-paths.generated.json` (only this lane's re-exports, if any), and
the DE-first i18n shard are shared by row/line; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-22T13:10Z · kiro-202610151913-51bd · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 5 rows and the paths were computed from the
parity ledger and `src/App.tsx` so no file belongs to two lanes; no `depends_on` (no shared component twin). Next:
PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-ai-pages/ai-coach --session <id>`). Runs in parallel with `ai-assistants` and
`ai-chat`.

### 2026-10-28T13:17Z · ci-plan-spar · ready (VTID allocated)
VTID-05397 allocated after policy approval (converged-auto-v1).
