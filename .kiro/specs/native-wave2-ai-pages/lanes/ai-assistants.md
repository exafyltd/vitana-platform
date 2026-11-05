---
lane: ai-assistants
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/assistant/**
  - apps/mobile/src/screens/ai-assistants/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/ai-assistants/**
  - apps/mobile/maestro/ai-assistants/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/aiAssistantsNative.json
  - docs/validation/**
updated: 2026-10-28T13:17Z
vtid: VTID-05395
---
# AI assistants management port — `/assistant` (+ 5 tabs); the useAIAssistants management flow
Plan: `.kiro/specs/native-wave2-ai-pages/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: ai-assistants -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 6 ledger rows under `"lane": "ai"` for this lane, all `not_started` —
`ASSISTANT.OVERVIEW /assistant`, `ASSISTANT.AI /assistant?tab=ai`, `ASSISTANT.AUTOPILOT /assistant?tab=autopilot`,
`ASSISTANT.PROACTIVE /assistant?tab=proactive`, `ASSISTANT.REFERRALS /assistant?tab=referrals`,
`ASSISTANT.VOICE /assistant?tab=voice` — all the same web file `src/pages/assistant/AIAssistant.tsx` (144 lines;
lazy-import `src/App.tsx:224`, route `:1470-1474`), a tabbed settings/preferences screen bound to
`useUserPreferences` (panels: `VoiceSettingsPanel`, `AIModelSettingsPanel`, `AutopilotSettingsPanel`,
`ProactiveTalkingPanel`, `VaeaConfigPanel`). Management hook `src/hooks/useAIAssistants.ts` (class B — `:11` imports
`@/integrations/supabase/client`, wraps `/api/v1/integrations/ai-assistants`). **`ASSISTANT.VOICE` is the
voice-settings tab (`VoiceSettingsPanel`), not the live voice-to-voice ORB session (out of scope, G1/audio spike).**
The six rows share one native route file reading the `tab` search param (`shapeOf` drops the query —
`parity-ledger.mjs:60`).
**Goal.** Port the `/assistant` management/preferences screen to native on the N3 shell at 1:1 mobile-web parity:
one route file reading the `tab` param selects the five panel twins (each bound to a native `useUserPreferences`
re-implementation), and the `useAIAssistants` provider list / paste-and-verify / connect-disconnect flow is
re-implemented natively over the native gateway + auth port (no raw key stored or shown). Flips all 6 rows to
`native`. All AI data paths are class B and re-implemented natively, not extracted.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the `/assistant` surfaces; mobile-web parity; `@vitana/core`-only web bridge (class-B
  re-implemented natively); `ASSISTANT.VOICE` is the settings tab, not the live ORB session.
- `npm run typecheck`, `npm test` (the `tab` param selects each of the five panels incl. `voice`; preferences
  toggle round-trip; `useAIAssistants` provider list/connect/disconnect loaded/empty/error from a fake gateway;
  corrected N2 range `Slider`/`Progress`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with all 6 rows `native` and the single
  `(app)/assistant/index.tsx` route present; `node scripts/native/core-closure.mjs --check` green **if** a core
  re-export was added.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored, pt Brazilian você-form;
  RTL (`ar`) covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 7)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 6 rows), `packages/core/manifest.json`
+ closure + `src/**` + `scripts/native/mobile-ci-paths.generated.json` (only this lane's re-exports, if any), and
the DE-first i18n shard are shared by row/line; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-22T13:10Z · kiro-202610151913-51bd · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 6 rows (one route file, five `?tab=` variants)
and the paths were computed from the parity ledger and `src/App.tsx` so no file belongs to two lanes; no
`depends_on`. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-ai-pages/ai-assistants --session <id>`). Runs in parallel with `ai-coach` and
`ai-chat`.

### 2026-10-28T13:17Z · ci-plan-spar · ready (VTID allocated)
VTID-05395 allocated after policy approval (converged-auto-v1).
