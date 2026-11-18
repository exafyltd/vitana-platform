# Tasks - staging-manifest-remainder
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/staging-manifest-remainder/<lane>`; title
`VTID-xxxxx (staging-manifest-remainder/<lane>): ...`; trailers; `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: remainder-05504 -->
## Lane `remainder-05504`
- [ ] T1 Baseline: the drift guard on `main`, recorded in outputs/baseline-red.txt (finding: tests must be a non-empty array).
- [ ] T2 Move the jest suite to `services/gateway/test/vtid-05504-morning-health-pertenant.test.ts` and update its `Run:` comment.
- [ ] T3 VTID-05504 manifest: one `existing` entry, `npx jest test/vtid-05504-morning-health-pertenant.test.ts`, `cwd: services/gateway`. Keep `not_verified_on_staging`.
- [ ] T4 The gateway jest run of the moved suite passes; the guard is green for 05504.

**Acceptance**
- Change types: Tooling/docs, Backend (test file moved, no product code)
- **Outcome** - the morning health check's per-tenant row is still proved by a test the guard can find.
- **Contract** - the moved suite passes from `services/gateway`; no network; no write.
- **Staging proof** - not verified on staging; covered by the guard and the gateway jest run.

<!-- lane: remainder-migration-scripts -->
## Lane `remainder-migration-scripts`
- [ ] T1 Baseline: `validateManifest` rejects the refs of VTID-05506 and 05507 on `main`.
- [ ] T2 `package.json`: one new script `test:migration-drift` = `node --test scripts/ci/check-migration-drift.test.cjs`.
- [ ] T3 VTID-05506 and 05507 `tests[0]` ref becomes `npm run test:migration-drift`; reasons unchanged.
- [ ] T4 Both manifests validate; the drift test passes unchanged.

**Acceptance**
- Change types: Tooling/docs
- **Outcome** - the migration drift suite runs through a valid root script, with the same file and runner.
- **Contract** - no other script changes; existing refs keep their meaning.
- **Staging proof** - not verified on staging; covered by the guard.

<!-- lane: remainder-05609 -->
## Lane `remainder-05609`
- [ ] T1 Baseline: the guard finds `tests must be a non-empty array` in VTID-05609.
- [ ] T2 Add one `/alive` http probe, the same shape as other docs-only manifests. Keep `not_verified_on_staging` and its reason.
- [ ] T3 The guard is green for 05609.

**Acceptance**
- Change types: Tooling/docs
- **Outcome** - VTID-05609 has a staging probe that proves the gateway is alive after its change.
- **Contract** - GET /alive; no write.
- **Staging proof** - the probe runs in the next full gateway STAGING-VERIFY.
