---
lane: ai-chat
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/comm/talk-to-vitana.tsx
  - apps/mobile/src/screens/ai-chat/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/ai-chat/**
  - apps/mobile/maestro/ai-chat/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/aiChatNative.json
  - docs/validation/**
updated: 2026-10-28T13:17Z
vtid: VTID-05396
---
# Chat-with-Vitana text screen port — `/comm/talk-to-vitana`
Plan: `.kiro/specs/native-wave2-ai-pages/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: ai-chat -->` (tasks 1–7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 1 ledger row under `"lane": "ai"` for this lane, `not_started` —
`COMM.TALK_TO_VITANA /comm/talk-to-vitana`. Web source `src/pages/community/TalkToVitana.tsx` (201 lines;
lazy-import `src/App.tsx:260`, route `:1289-1293`) — the text-first chat / feedback ticket capture screen (topic
`Select` over `TICKET_KINDS`, a multiline `Textarea` maxLength 10 000, submit through `communityFetch`
(`@/lib/community-gateway`, class B) to `/api/v1/feedback/tickets`, a success notice with a `?ticket=` deep link,
and the member's `MyTicketsList` below). Its own header comment records that voice intake is a later, separate
concern — this is the TEXT screen only.
**Goal.** Port the Talk-to-Vitana text screen to native on the N3 shell at 1:1 mobile-web parity: the native form
(select + multiline input + submit) posts to `/api/v1/feedback/tickets` through the native community-gateway port +
native auth context (class B, re-implemented), shows the success notice with the ticket number + `?ticket=` link,
and renders the `MyTicketsList` twin below. Flips the 1 parity row to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for `/comm/talk-to-vitana`; mobile-web parity; `@vitana/core`-only web bridge (the gateway
  fetch re-implemented natively).
- `npm run typecheck`, `npm test` (empty-text submit blocked; submit → success notice + ticket number + `?ticket=`
  link via a fake gateway; ticket list loaded/empty/error; `?ticket=` deep link opens the right ticket),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 1 row `native` and its route present in
  `apps/mobile/app/`; `node scripts/native/core-closure.mjs --check` green **if** a core re-export was added.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored, pt Brazilian você-form;
  RTL (`ar`) covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 6)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 1 row), `packages/core/manifest.json`
+ closure + `src/**` + `scripts/native/mobile-ci-paths.generated.json` (only this lane's re-exports, if any), and
the DE-first i18n shard are shared by row/line; resolve a merge conflict by keeping both lanes' rows/keys. This
lane names its single native route file `apps/mobile/app/(app)/comm/talk-to-vitana.tsx` explicitly (not a
`comm/**` glob) so it never collides with a future `comm` lane in another plan.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-22T13:10Z · kiro-202610151913-51bd · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 1 row and the paths were computed from the
parity ledger and `src/App.tsx` so no file belongs to two lanes; no `depends_on`. Next: PLAN-SPAR spars the plan;
once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-ai-pages/ai-chat --session <id>`). Runs in parallel with `ai-coach` and
`ai-assistants`.

### 2026-10-28T13:17Z · ci-plan-spar · ready (VTID allocated)
VTID-05396 allocated after policy approval (converged-auto-v1).
