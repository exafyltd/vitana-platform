---
lane: autopilot-audiobook
state: ready
next_actor: kiro
depends_on: [journey]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/autopilot/audiobook.tsx
  - apps/mobile/src/screens/audiobook/**
  - apps/mobile/maestro/audiobook/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/parity/ledger.json
  - apps/mobile/tests/audiobook/**
  - src/i18n/*/journeyAutopilotNative.json
  - docs/validation/**
  - packages/core/extract.json
updated: 2026-11-01T17:10Z
---
# Audiobook deep-link + player port — `/autopilot/audiobook` (push deep link that starts the native player)
Plan: `.kiro/specs/native-wave2-journey-autopilot-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: autopilot-audiobook -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do
not start before `vtid:` is set here. **depends_on `journey`:** this lane renders the My Journey dashboard screen that
the `journey` lane owns, via a port (design decision 3), and consumes the core helpers `journey` adds — start only
after `journey` is `done`.
**Measured on the worktree (= origin/main):** 1 ledger row under `"lane": "journey-autopilot"` for this lane,
`not_started` — `/autopilot/audiobook` (`kind: route`, `source: exclusion`; `scripts/native/parity-scope.json:77`,
`src/navigation/registry/exclusions.json:211`). Web route `src/App.tsx:1544-1548` renders `AutopilotDashboard` and
starts the app-wide audiobook player, settling the URL on `/autopilot` (VTID-04763). Web sources: the app-wide player
provider `src/context/AudiobookPlayerProvider.tsx` (528; VTID-04761, runtime-imports `@/lib/community-gateway:33`,
class-B), the mini-player `src/components/audiobook/AudiobookMiniPlayer.tsx` (259), the reminder control
`src/components/audiobook/AudiobookReminderControl.tsx`.
**Goal.** Port the audiobook push deep-link to native on the N3 shell at 1:1 mobile-web parity: the native audiobook
player (re-implementation of `AudiobookPlayerProvider`, playing via `expo-av` / `expo-audio` — class-B, NOT
extracted), the native mini-player + reminder control twins, and the `/autopilot/audiobook` route that renders the
`journey` lane's dashboard through a port and, on mount, starts the player and redirects to `/autopilot`. Flips the 1
parity row to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for `/autopilot/audiobook`; mobile-web parity; `@vitana/core`-only web bridge; the player
  re-implemented natively (class-B, no extraction); the dashboard rendered via a port (no duplicate owner).
- `npm run typecheck`, `npm test` (episodes loaded/empty/error; play/pause/seek; deep-link starts the player and
  redirects to `/autopilot`; mini-player renders), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 1
  row `native` and its route `apps/mobile/app/(app)/autopilot/audiobook.tsx` present.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) in `src/i18n/*/journeyAutopilotNative.json`
  then mirrored; RTL (`ar`) covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's read-only spec)
  and `plan-sparring.md` (copy of the plan's sparring record).
- **Device-runtime parity (task 7)** — Maestro + sim/emulator screenshots + parity vs 390×844 staging **and audio
  playback on a device/simulator with an audio route** — is deferred to G1 as `next_actor: owner`; not a merge blocker
  for the port, recorded in this log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 1 row), `packages/core/manifest.json`
+ closure + `src/**` + `scripts/native/mobile-ci-paths.generated.json` (this lane adds no core re-export, but lists
them so a conflict with `journey`'s core edits resolves by keeping both), and the DE-first i18n shard are shared by
row/line; resolve a merge conflict by keeping both lanes' rows/keys. `apps/mobile/src/ports/**` and
`apps/mobile/src/navigation/resolve.ts` are shared native-infra read surfaces listed so the Lane-scope check does not
fail; this lane does not restructure them.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-11-01T17:10Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan (re-plan of `native-wave2-journey-autopilot/autopilot-audiobook`, PR #4270); `paths` widened to the shared native-infra files.
