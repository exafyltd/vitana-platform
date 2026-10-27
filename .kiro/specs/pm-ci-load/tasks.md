# Tasks — pm-ci-load
Authoritative plan: `plan.md` (between the plan markers). VTIDs from CI PLAN-SPAR after policy approval; never by
hand. Branches `kiro/pm-ci-load/<lane-id>`; PR titles `VTID-xxxxx (pm-ci-load/<lane-id>): …`; `Collab-Session` +
`Collab-Lane` trailers; identity `kiro-agent[bot]`; no `Co-Authored-By: Claude`. Evidence in `docs/validation/<VTID>/`.

<!-- lane: pr-ci-concurrency -->
## Lane `pr-ci-concurrency` (vitana-platform; executor kiro; reviewer agent)
- [ ] C1 `scripts/ci/workflow-concurrency/concurrency.test.mjs` per plan §3 lane 1 item 2, red on `origin/main`.
- [ ] C2 The `concurrency` block in `UNIT.yml` and `PHASE-2B-DOC-GATE.yml` (item 1).
- [ ] C3 `node --test scripts/ci/workflow-concurrency/*.test.mjs`, preflight; after merge, the §6 measurement.

**Acceptance**
- Change types: Infrastructure/CI.
- No trigger, job, step or path filter changes; only the `concurrency` key is added (diff).
- Both workflows still run every job on every PR head.

<!-- lane: pm-app-token -->
## Lane `pm-app-token` (vitana-platform; executor kiro; reviewer agent)
- [ ] A1 `github-app-token.test.ts` per plan §3 lane 2 item 3, red on `origin/main`.
- [ ] A2 `github-app-token.ts` and the `token()` change in `github-rest.ts` (items 1-2).
- [ ] A3 `docs/project-manager/github-app.md` (item 4, plan §4-§5); `staging-tests.json` (item 5).
- [ ] A4 gateway `npx jest test/project-manager`, `tsc --noEmit`, preflight.
- [ ] A5 Merge only after `pm-reassign-idempotent/reassign-noop` is merged (item 6); then STAGING-VERIFY.

**Acceptance**
- Change types: Backend, Integration.
- Converging round 2 note (R2-F1, minor): `token()` becomes `async token(repo): Promise<string>` and `gh()` awaits it;
  confined to `github-rest.ts`, no caller signature changes.
- With the three variables unset, every PM GitHub call uses exactly today's token (test).
- The token request asks for exactly the §4 permissions on the two repos; no secret value is logged (test on the log
  line).
- Merged after #4396's lane; STAGING-VERIFY passed on the merge commit.
