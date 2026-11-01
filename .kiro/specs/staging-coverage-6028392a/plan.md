# Plan — staging-coverage-6028392a
Put the already-merged live-room notification fix (#4539, commit `6028392a12f3449a51cea7b77fe2fb64f4aaee92`) through
the pipeline it skipped: spar it, give it a CI VTID, a CI test that proves the changed behaviour, a read-only staging
suite and a `commit-coverage.json` entry, so STAGING-VERIFY rule 47 stops failing on it.
<!-- plan:begin -->
## Problem
PR #4539 (`fix(live): only notify followers when a live room actually starts`, author and merger `exafyltd`, merged
2026-10-31T15:45:50Z) landed on `main` as `6028392a12f3449a51cea7b77fe2fb64f4aaee92` with no VTID in its subject and
no `docs/validation/<VTID>/staging-tests.json`. It changed one file, `services/gateway/src/routes/live.ts`
(+82/−70). Its PR body says tsc was not run ("no node_modules in the sandbox").
Gateway staging now serves `1654c774` (deploy run 41273637049). STAGING-VERIFY run 41277204760 passed all 37 tests but
failed on rule 47 alone: `6028392a` is in the production..staging range, touches `services/gateway` and has no change
suite (`scripts/ci/staging-verify/lib.cjs` `planRange`, "Missing change suite"). Every gateway commit in that range now
waits on it for Gate 2. No open PR, lane or spec names #4539 or `6028392a` (checked `gh pr list`, `git grep` of
`.kiro/`, `docs/`, `scripts/` on origin/main `1654c774`).
## What #4539 changed (behaviour being recorded, cited at origin/main 1654c774)
- New `notifyRoomWentLive(roomId, hostId, sessionTitle?)` (`live.ts:1013`) holds both go-live notifications:
  followers (`repo.fetchLiveRoomAttendeesExcluding` → `notifyLiveRoomLocalized(..., 'live_room_starting', ...)`) and
  "Notify me" subscribers (`repo.fetchLiveStreamSubscribersExcluding` → `notifyUserAsync(..., 'live_room_starting',
  notif.live_going_live.*)`, `live.ts:1066-1070`, fan-out log line `:1072`). Host excluded from both.
- `POST /rooms/:id/sessions` calls it only when `result.status !== 'scheduled'` (`live.ts:2077-2080`). Before, the
  follower notification went out on every session create, including scheduled ones, so the push said "starting" while
  a tap returned `NOT_LIVE`.
- `POST /rooms/:id/enter`: when the host enters a scheduled session and `sessionManager.startForHost` succeeds
  (`live.ts:1130`), it now awaits `notifyRoomWentLive(roomId, identity.user_id)` (`live.ts:1138`).
- `POST /rooms/:id/start` no longer sends the "Notify me" fan-out (removed from old `live.ts:645-681`).
## Goal
1. A converged, policy-approved sparring record for exactly the `6028392a` change.
2. One CI-allocated VTID for the lane below.
3. A jest test that proves the three intended behaviours, because they are notification writes that cannot run on
   staging (rule 48, absolute rule: no writes to shared data).
4. `docs/validation/<VTID>/staging-tests.json` (read-only, service `gateway`) and a `docs/validation/commit-coverage.json`
   entry mapping `6028392a12f3449a51cea7b77fe2fb64f4aaee92` to that VTID, so the next gateway STAGING-VERIFY whose
   range contains `6028392a` lists it as covered and runs the suite.
## Scope (lane `notify-coverage`)
- `services/gateway/test/vtid-<NNNNN>-live-notify-only-when-live.test.ts` (new): same harness as
  `test/vtid-04905-live-enter-exit.test.ts` (live router on express, auth mocked, `notification-service` and
  `@supabase/supabase-js` in memory, fetch mock for Supabase RPC/Daily). Cases:
  1. session create that comes back `scheduled` → no `live_room_starting` notification to followers or subscribers;
  2. session create that comes back live/lobby → followers and subscribers get `live_room_starting`, host excluded;
  3. host enters a scheduled session, `startForHost` succeeds → followers and subscribers notified, host excluded;
  4. host start that `startForHost` refuses → no go-live notification;
  5. a viewer entering an already-live room → no go-live fan-out.
  The test only adds coverage; it does not change `live.ts`.
- `docs/validation/<VTID>/staging-tests.json` — service `gateway`, read-only:
  - `GET /alive` → 200;
  - `GET /api/v1/live/health` → 200, `expect_json {"ok": true, "service": "live-gateway"}` (`live.ts:1783`, mounted at
    `/api/v1/live`, `index.ts:1337`): proves the live router carrying #4539 loaded on the deployed commit;
  - `POST /api/v1/live/rooms/00000000-0000-4000-8000-000000000000/enter` as `rejected_probe: true`,
    `expect_status: 401`: `requireAuth` rejects the invalid bearer before the handler that now calls
    `notifyRoomWentLive` runs (`live.ts:1096`). `POST /rooms/:id/sessions` is deliberately not probed: it uses
    `optionalAuth` and only checks that a bearer is present (`live.ts:2017-2022`), so an invalid bearer reaches the
    handler.
  - `existing`: `ref: npx jest test/vtid-<NNNNN>-live-notify-only-when-live.test.ts test/vtid-04905-live-enter-exit.test.ts`,
    `cwd: services/gateway`, with the reason that this is the write-path proof of the change.
- `docs/validation/commit-coverage.json` — one `covers[]` entry `{sha: 6028392a12f3449a51cea7b77fe2fb64f4aaee92,
  vtid: <VTID>, reason, approved_by: "converged-auto-v1 <sparring record>"}` in the format `lib.cjs`
  `parseCommitCoverage` parses. Existing entries kept.
- `docs/validation/<VTID>/plan-sparring.md` — copy of the sparring record and verdict.
## Out of scope
- Changing `live.ts`. In particular the removal of the "Notify me" fan-out from `POST /rooms/:id/start`: the community
  app still calls that route (vitana-v1 `src/services/liveRoomService.ts:337`, `src/hooks/useLiveStreams.ts:296`), so
  after #4539 a stream started through `/start` alone sends no go-live push to Notify-me subscribers. Whether that is
  wanted is a product decision; this plan records it, does not pin it in a test either way, and reports it to the
  owner for a separate plan.
- Any other commit in the production..staging range.
## Verification
- Local, before the lane PR: `npx jest test/vtid-<NNNNN>-live-notify-only-when-live.test.ts
  test/vtid-04905-live-enter-exit.test.ts` and `npx tsc --noEmit` in `services/gateway`;
  `node --test scripts/ci/staging-verify/lib.test.cjs`; `validateManifest` on the new manifest; `parseCommitCoverage`
  keeps the new entry.
- Red check: the new test cases 1 and 3 fail against `6028392a^1` (`live.ts` before #4539), recorded in
  `docs/validation/<VTID>/commands.log`.
- CI: gateway jest and PR-GATE on the lane PR; pre-merge STAGING-VERIFY `check-pr` validates the manifest.
- Staging: the next gateway STAGING-VERIFY on a commit containing the entry lists `6028392a` as covered, runs this
  suite and passes. Read-only; nothing targets production.
## Risks
- A coverage entry can hide an unverified change. Mitigation: one sha, a new test that fails without the change, the
  sparring record linked in `approved_by`.
- The staging probes do not exercise the notifications (no read-only surface does). Accepted: rule 48 puts write-path
  proof in CI tests; the `existing` entry runs them in STAGING-VERIFY.
<!-- plan:end -->
