# Tasks — Native Wave 2: Journey / Guided mode / Autopilot screen ports
Two lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI
after PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from
`apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline.
<!-- lane: journey -->
## Lane `journey` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `AUTOPILOT.MY_JOURNEY /autopilot` (1 ledger row under `"lane": "journey-autopilot"`). depends_on: none. Web
source `src/pages/AutopilotDashboard.tsx` (605 lines; route `src/App.tsx:1538-1543`). **This lane owns the core
extraction** of the two pure helpers (design decision 2).
- [ ] 1. Core re-exports (pure/class-A only): add manifest lines for `src/lib/horizonBuckets.ts` and
  `src/lib/vitana-projection.ts` (both IO-free — no `@/integrations/supabase/client`, no `@/lib/community-gateway`),
  each with a re-export in `packages/core/src/**`, then `node scripts/native/core-closure.mjs --write` and commit the
  regenerated generated files in this same PR. Do NOT add any hook/provider (`use-autopilot`, `GuidedModeProvider`,
  `useGuidedJourneyProgress`, `useMyJourney`, `journeyPractice`) — they are class-B and are re-implemented natively
  (task 2). `src/types/autopilot.ts` is already a core type re-export — reuse it.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck` green.
- [ ] 2. Native guided-mode + autopilot + journey-progress providers (class-B, re-implemented, not extracted):
  `apps/mobile/src/screens/journey/providers/` — native twin of `GuidedModeProvider` (mode cache + resolve via native
  auth + native gateway fetch), `use-autopilot` (native Supabase client on the ports + native KV for snooze/dismiss),
  and `useGuidedJourneyProgress` (native gateway + native KV for listened sessions). Consume the pure helpers from
  `@vitana/core` and types from `src/types/autopilot` (core).
  Files: `apps/mobile/src/screens/journey/providers/**`, `apps/mobile/src/screens/journey/hooks/**`.
  Verify: `npm run typecheck`; `npm test` — provider unit tests (mode toggle, snooze persistence) pass.
- [ ] 3. Native My Journey dashboard screen on the N3 shell (`dashboard` Spotlight archetype):
  `apps/mobile/src/screens/journey/JourneyScreen.tsx` renders the mobile-web branch of `AutopilotDashboard.tsx`
  section by section — Spotlight `JourneyHero` + goal/dream north-star as the single `spotlight` `VCard`, Vitana Index
  trajectory card, the `GuidedModeSwitch`, the guided-journey catalog with teacher/topic rows (twin of
  `GuidedJourneyCatalog.tsx`), `JourneyHowItWorks`, and the today's-goal / future-self / matches / events / autopilot
  preview tiles as `standard` `VCard`s. Header chips (`VitanaIndexChip`/`AutopilotChip` twins) and the `MobileModePill`.
  Matches/events tiles deep-link by path only.
  Files: `apps/mobile/app/(app)/autopilot/index.tsx`, `apps/mobile/src/screens/journey/**`.
  Verify: `npm test` (the dashboard unit tests below) + `npm run typecheck` green.
- [ ] 4. Autopilot recommendations popup + goal sheets: the autopilot popup as a native bottom sheet (twin of
  `src/components/AutopilotPopup.tsx`) backed by the native autopilot hook (task 2); `GoalSetupDialog` /
  `GoalPlanSheet` as the kit's bottom sheets. Goal-plan generation (`useGenerateGoalPlan`) passes the user's preferred
  language so the backend injects it (R2.5 AI-content locale rule).
  Files: `apps/mobile/src/screens/journey/**`.
  Verify: `npm test` — popup open/snooze/dismiss + goal-sheet open tests; `npm run typecheck` green.
- [ ] 5. i18n + RTL: user-visible strings from the web shards (`screens.autopilotdashboard.*` in
  `src/i18n/*/screens.json`, `src/i18n/*/autopilot.json`); any genuinely new native-only key added to
  `src/i18n/de/journeyAutopilotNative.json` first, then the other ten (ar de en es fr pl pt ru sr tr zh); render under
  `ar` with start/end only; no hardcoded text, no physical `left`/`right`.
  Files: `src/i18n/*/journeyAutopilotNative.json` (DE first), `apps/mobile/src/screens/journey/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 6. Unit tests (fake gateway / fixtures, no network): dashboard loaded / empty / error; each section renders;
  guided-mode toggle switches mode via the native provider stub; catalog renders topic/teacher rows; autopilot popup
  opens and snooze/dismiss persists to the native KV stub; goal-plan sheet opens; pure `horizonBuckets` /
  `vitana-projection` tested through their core entry. React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/src/screens/journey/__tests__/**`, `apps/mobile/app/(app)/autopilot/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 7. Flip the lane's parity row to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native` for `AUTOPILOT.MY_JOURNEY` only), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (journey row only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 8. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/journey/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 read-only staging web `/autopilot`. Blocked until G1 (and macOS minutes / G3 for iOS on a
  device).
  Files: `apps/mobile/maestro/journey/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 9. PR: branch `kiro/native-wave2-journey-autopilot-r2/journey`, title
  `VTID-xxxxx (native-wave2-journey-autopilot-r2/journey): native My Journey / guided-mode / autopilot dashboard port`,
  body names the Kiro session id, Summary / Decisions taken / Tests / Handoff. Commit trailers
  `Collab-Session: <kiro id>`, `Collab-Lane: native-wave2-journey-autopilot-r2/journey`. Lane → `in-review`,
  `next_actor: kiro` (reviewer seat `hotmail`). Never merge, deploy or write to a live system (protocol §7a).
<!-- lane: autopilot-audiobook -->
## Lane `autopilot-audiobook` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports: `/autopilot/audiobook` (1 ledger row, `kind: route`, `source: exclusion`). depends_on: `journey` (renders the
dashboard screen that `journey` owns, via a port — design decision 3). Web route `src/App.tsx:1544-1548` renders
`AutopilotDashboard` and starts the app-wide player; player sources `src/context/AudiobookPlayerProvider.tsx` (528;
VTID-04761), `src/components/audiobook/AudiobookMiniPlayer.tsx` (259), `AudiobookReminderControl.tsx`.
- [ ] 1. Native audiobook player provider (class-B, re-implemented, not extracted):
  `apps/mobile/src/screens/audiobook/AudiobookPlayerProvider.tsx` — native twin of `AudiobookPlayerProvider`
  (`:33` runtime-imports `@/lib/community-gateway`, so NOT extracted); fetch episodes through the native gateway, play
  via `expo-av` / `expo-audio` (program library map §3). No core re-export in this lane (it adds none).
  Files: `apps/mobile/src/screens/audiobook/AudiobookPlayerProvider.tsx`, `apps/mobile/src/screens/audiobook/**`.
  Verify: `npm run typecheck`; `npm test` — provider unit tests (load episodes, play/pause/seek, empty, error) pass.
- [ ] 2. Native mini-player + reminder control: `apps/mobile/src/screens/audiobook/AudiobookMiniPlayer.tsx` (twin of
  the 259-line web mini-player) and the reminder-control twin, composed through N2/N3; mounted as an app-wide overlay
  the same way the web mini-player is (web `src/App.tsx:810`).
  Files: `apps/mobile/src/screens/audiobook/AudiobookMiniPlayer.tsx`,
  `apps/mobile/src/screens/audiobook/AudiobookReminderControl.tsx`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Audiobook deep-link route `apps/mobile/app/(app)/autopilot/audiobook.tsx`: render the `journey` lane's
  dashboard screen through a port (no duplicate dashboard), and on mount start the native player and redirect the
  route to `/autopilot` — the web "start player, settle on /autopilot" behaviour (VTID-04763, `src/App.tsx:1544-1548`).
  Files: `apps/mobile/app/(app)/autopilot/audiobook.tsx`.
  Verify: `npm test` — the deep-link test starts the player stub and resolves the redirect; `npm run typecheck` green.
- [ ] 4. i18n + RTL (as journey task 5) for the player + mini-player; new keys DE-first in
  `src/i18n/de/journeyAutopilotNative.json` then the other ten.
  Files: `src/i18n/*/journeyAutopilotNative.json` (DE first), `apps/mobile/src/screens/audiobook/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures): episodes loaded / empty / error; play/pause/seek; deep-link starts the
  player and redirects to `/autopilot`; mini-player renders. React 19 `ReactElement`.
  Files: `apps/mobile/src/screens/audiobook/__tests__/**`, `apps/mobile/app/(app)/autopilot/__tests__/**`
  (this lane owns `audiobook.tsx`'s tests; `journey` owns `index.tsx`'s).
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's parity row (`/autopilot/audiobook`) to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (audiobook row only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro
  `apps/mobile/maestro/audiobook/*.yaml` + sim/emulator screenshots + parity vs 390×844 staging `/autopilot/audiobook`,
  **and audio playback on a device/simulator with an audio route**. Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/audiobook/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 8. PR: branch `kiro/native-wave2-journey-autopilot-r2/autopilot-audiobook`, title
  `VTID-xxxxx (native-wave2-journey-autopilot-r2/autopilot-audiobook): native audiobook deep-link + player port`;
  trailers `Collab-Session`, `Collab-Lane: native-wave2-journey-autopilot-r2/autopilot-audiobook`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.

## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity, N2/N3 composition, `@vitana/core`-only bridge.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's row `native`; `node scripts/native/core-closure.mjs --check` green.
- 11 locales, DE-first new keys, RTL covered; no hardcoded user-visible text; no physical `left`/`right`.
- AI-content i18n: any LLM call on the user's behalf (goal-plan, guided journey/teacher) carries the user locale.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity (the G1 task) is deferred to G1 as `next_actor: owner`; it is not a merge blocker for the
  port, it is recorded in the lane log and `staging-tests.json`.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
