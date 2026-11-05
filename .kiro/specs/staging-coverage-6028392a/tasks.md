# Tasks — staging-coverage-6028392a
<!-- lane: notify-coverage -->
## Lane: notify-coverage
Gives the merged live-room notification fix (`6028392a`, #4539) its VTID test, suite and commit coverage.
- [ ] T1 — `services/gateway/test/vtid-<NNNNN>-live-notify-only-when-live.test.ts`: the five cases of plan §Scope.
  Acceptance (R2): green on the lane head; cases 1 and 3 red against `live.ts` of `6028392a^1` (logged).
- [ ] T2 — `docs/validation/<VTID>/staging-tests.json`: gateway, `/alive`, `/api/v1/live/health`, `/enter` rejected
  probe (401), `existing` jest entry. Acceptance (R4): `validateManifest` ok; every test read-only.
- [ ] T3 — `docs/validation/commit-coverage.json`: append the `6028392a12f3449a51cea7b77fe2fb64f4aaee92` entry.
  Acceptance (R5): `node --test scripts/ci/staging-verify/lib.test.cjs` green; `parseCommitCoverage` keeps the entry.
- [ ] T4 — `docs/validation/<VTID>/plan-sparring.md`, `commands.log`.
- [ ] T5 — Checks: the jest entry, `npx tsc --noEmit` (services/gateway). Acceptance (R1): `live.ts` unchanged.
