---
lane: media-hub
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/comm/media-hub.tsx
  - apps/mobile/app/(app)/community/media-hub.tsx
  - apps/mobile/src/screens/media/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/media/**
  - apps/mobile/tests/app-config.test.ts
  - apps/mobile/maestro/media/**
  - apps/mobile/package.json
  - apps/mobile/package-lock.json
  - apps/mobile/app.config.ts
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/extract.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/mediaHubNative.json
  - docs/validation/**
updated: 2026-11-01T17:25Z
---
# Media Hub port — the 4 `media` ledger rows under `/comm/media-hub*`
Plan: `.kiro/specs/native-wave2-media-hub/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: media-hub -->` (tasks 1–10) are authoritative. The spec stays on the plan branch until this lane merges:
`git show origin/kiro/native-wave2-media-hub/plan:.kiro/specs/native-wave2-media-hub/<file>`. VTID: assigned by CI
after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured (vitana-v1 origin/main `a41e89a0d`, ledger version 2, 435 rows):** 4 rows under `"lane": "media"`, all
`not_started` — `COMM.MEDIA_HUB /comm/media-hub`, `COMM.MEDIA_MUSIC ?tab=music`, `COMM.MEDIA_PODCASTS ?tab=podcasts`,
`COMM.MEDIA_SHORTS ?tab=shorts` (`ledger.json:737-783`). All resolve to `src/pages/community/MediaHub.tsx` (1622
lines, route `src/App.tsx:1263-1267`, legacy redirect `:1321`); `tab` picks the mode (`MediaHub.tsx:237-247`). One
native route reads `tab` and `short`; the 4 rows flip together.

**Goal.** Port the non-Spotlight mobile branch 1:1: header + action rail, `MobileModePill`, enrichment strip, shorts
carousel → full-screen feed (expo-video, like, comments, share, owner edit/delete, demo fallback), music list
(expo-audio play/pause, bookmark, share), podcast list (play), upload sheet (video via expo-image-picker, music /
podcast via expo-document-picker). Only `src/lib/shortsTags.ts` is class-A (core re-export) plus 3 extracted types;
every data path is class-B, re-implemented behind `apps/mobile/src/ports/media.ts` (`MediaHubData`) on
`getSupabase()` / `getGateway()`. New Expo packages with their config plugins in `app.config.ts` (never a camera or
microphone option set to `false`; the ORB voice plugin owns the microphone string).

**Acceptance:** the `tasks.md` lane section "Acceptance" bullets.

**Shared files.** `apps/mobile/parity/ledger.json` (this lane's 4 rows + 1 `native_only` entry),
`apps/mobile/src/navigation/resolve.ts` (2 `NATIVE_ROUTES` lines), `apps/mobile/src/ports/**` (new `media.ts`),
`packages/core/**` + `scripts/native/mobile-ci-paths.generated.json` (regenerate, never hand-merge),
`apps/mobile/package.json` / `package-lock.json` / `app.config.ts` / `tests/app-config.test.ts` (also touched by the
`native-wave2-memory-diary-r2` `diary` lane: one plugin entry per package, merge options, keep every permission
string). Resolve conflicts by keeping both sides.

**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-11-01T17:25Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan.
