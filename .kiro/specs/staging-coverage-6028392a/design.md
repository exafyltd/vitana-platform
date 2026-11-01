# Design — staging-coverage-6028392a
## Current code (premises, cited at origin/main 1654c774)
- `services/gateway/src/routes/live.ts:1013` `notifyRoomWentLive`; `:1072` subscriber fan-out log line.
- `live.ts:1096` `POST /rooms/:id/enter` behind `requireAuth`; `:1130` `sessionManager.startForHost`; `:1138`
  `await notifyRoomWentLive(roomId, identity.user_id)`.
- `live.ts:2017` `POST /rooms/:id/sessions` (`optionalAuth`, bearer presence check only at `:2020-2022`); `:2077-2080`
  `if (result.status !== 'scheduled') await notifyRoomWentLive(...)`.
- `live.ts:1783` `GET /health` (public, `{ok: true, service: 'live-gateway', ...}`); router mounted at `/api/v1/live`
  (`services/gateway/src/index.ts:1337`).
- `services/gateway/test/vtid-04905-live-enter-exit.test.ts` — harness for the live router (auth, notification
  service, supabase-js and fetch mocked); it already has "host entering a scheduled session starts it" and session
  create cases, but no assertion on go-live notifications.
- `scripts/ci/staging-verify/lib.cjs` `parseCommitCoverage` / `planRange` (coverage only for a commit whose subject
  has no VTID; covering VTID needs `docs/validation/<VTID>/staging-tests.json`); `validateHttpTest` (non-GET only as
  `rejected_probe` with 401/403); `EXISTING_REF` allows `npx jest <paths>`.
## Changes (lane `notify-coverage`)
1. `services/gateway/test/vtid-<NNNNN>-live-notify-only-when-live.test.ts` — the five cases of plan §Scope, harness
   copied from the VTID-04905 test (no shared helper extracted; existing test untouched).
2. `docs/validation/<VTID>/staging-tests.json` — the four tests of plan §Scope, same shape as
   `docs/validation/VTID-05335/staging-tests.json`.
3. `docs/validation/commit-coverage.json` — append one `covers[]` entry for `6028392a`.
4. `docs/validation/<VTID>/plan-sparring.md` and `commands.log` (red/green evidence).
## Testing
`npx jest test/vtid-<NNNNN>-live-notify-only-when-live.test.ts test/vtid-04905-live-enter-exit.test.ts`,
`npx tsc --noEmit` (services/gateway), `node --test scripts/ci/staging-verify/lib.test.cjs`.
