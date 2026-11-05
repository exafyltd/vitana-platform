---
lane: community-hub
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/comm/**
  - apps/mobile/app/(app)/me/matches.tsx
  - apps/mobile/app/(app)/intents/**
  - apps/mobile/app/(app)/search.tsx
  - apps/mobile/src/screens/community/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/community/**
  - apps/mobile/maestro/community/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/communityHubNative.json
  - docs/validation/**
updated: 2026-11-01T03:05Z
vtid: VTID-05433
---
# Community hub / intents / search port — the 17 remaining `home-feed` ledger rows
Plan: `.kiro/specs/native-wave2-home-feed-news-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: community-hub -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 17 ledger rows under `"lane": "home-feed"` for this lane, all
`not_started` — `COMM.GROUPS /comm/groups`, `COMM.GROUPS_DISCOVER /comm/groups?tab=recommended`,
`COMM.GROUP_DETAIL /comm/groups/:id`, `/comm/my-groups/:id`, `COMM.MEMBERS /comm/members`,
`OVERLAY.PROFILE_PREVIEW /comm/members`, `COMM.OPEN_ASKS /comm/open-asks`, `COMM.FIND_PARTNER /comm/find-partner`,
`COMM.FIND_PARTNER_BOARD`, `COMM.FIND_PARTNER_MATCHES`, `COMM.FIND_PARTNER_POSTS` (`?view=…`), `COMM.MATCHES /me/matches`,
`INTENTS.BOARD /intents/board`, `INTENTS.MINE /intents/mine`, `INTENTS.MATCH_DETAIL /intents/match/:id`,
`SEARCH.OVERVIEW /search`. Web sources (with App.tsx cites) in `requirements.md` R0.4:
`community/Groups.tsx` (272, `:1226-1230`), `community/GroupDetail.tsx` (234, `:1231-1235`),
`community/Members.tsx` (332, `:1269-1274`), `community/OpenAsks.tsx` (289, `:1276-1281`),
`community/FindPartner.tsx` (780, `:1283-1287`), `MatchesPage.tsx` (183, `:1495-1499`),
`IntentBoard.tsx` (225, `:1508-1512`), `MyIntents.tsx` (202, `:1517-1521`),
`IntentMatchDetail.tsx` (192, `:1522-1526`), `Search.tsx` (492, `:1488-1492`).
**Goal.** Port the community hub, intents and search screens to native on the N3 shell at 1:1 mobile-web parity.
Each is a list / detail / sheet shape covered by the program §4 per-type functional checklist. Member-listing queries
(members, find-partner, open-asks) are **reused unchanged from `@vitana/core`**, so the test/service allowlist
exclusion (program NEVER rule 45) is inherited, not re-implemented — the PR states this. The find-match / age-range
filter uses the N2 kit's corrected range `Slider` (web defect not reproduced). Flips all 17 rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for all 17 destinations; mobile-web parity; `@vitana/core`-only web bridge; no new member-listing
  query (reuse, PR states the allowlist exclusion is inherited).
- `npm run typecheck`, `npm test` (list load/scroll-end/empty/error; detail open-from-list + deep-link + back;
  find-partner view switch; members profile-preview open/dismiss; search query→results/empty; intents board/mine/match),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with all 17
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 17 rows), `packages/core/manifest.json`
+ closure + `src/**` (only this lane's re-exports), and the DE-first i18n shard are shared by row/line; resolve a
merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-11-01T00:05Z · kiro-exafyltd-202611010001-8e5e · ready
Lane created with the plan (re-plan of `native-wave2-home-feed-news/community-hub`, PR #4273).

### 2026-11-01T03:05Z · ci-plan-spar · ready (VTID allocated)
VTID-05433 allocated after policy approval (converged-auto-v1).
