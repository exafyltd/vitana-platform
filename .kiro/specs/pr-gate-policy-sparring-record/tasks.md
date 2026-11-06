# Tasks — pr-gate-policy-sparring-record

<!-- lane: policy-approval-record -->
Repo `exafyltd/vitana-platform`. Code starts only after the VTID is allocated.
- [ ] T1 Add the five cases of plan § Tests to `scripts/ci/pr-gate/__tests__/lib.test.mjs`. Record the new cases red on
      `origin/main`.
- [ ] T2 Change `evaluateSparringRecord` in `scripts/ci/pr-gate/lib.mjs` (plan § Change 1–3). Nothing else.
- [ ] T3 Run `node --test scripts/ci/pr-gate/__tests__/*.test.mjs`; save the output to `docs/validation/<VTID>/commands.log`.
- [ ] T4 `docs/validation/<VTID>/scope.json`: `kind: infra`, and the two paths of this lane.
- [ ] T5 PR titled `VTID-xxxxx (pr-gate-policy-sparring-record/policy-approval-record): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — CI and developers: a PR of a plan approved by policy shows the PR-GATE sparring check as passed. A record
  with no approval at all still fails it.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI and no user-visible string.
- **Contract** — n/a: the function's name, arguments and return value (a list of problems) are unchanged. Only the accepted
  text changes.
- **Staging proof** — not verified on staging: the change deploys nothing. The covering tests are the PR-GATE node tests
  that `PR-GATE.yml` runs on the PR head.
- **Reviewer** — no rule weakened: the owner-approval form passes as before. A policy approval needs CONVERGED, a plan hash
  and the exact policy name. Each case is pinned by a test.
- Diff only inside the lane `paths`; no test skipped or loosened.

<!-- lane: policy-approval-record-v1 -->
Repo `exafyltd/vitana-v1`. The same change as the platform lane, applied to the vitana-v1 copy. Code starts only after the
VTID is allocated.
- [ ] T1 Add the same five cases to `scripts/ci/pr-gate/__tests__/lib.test.mjs`. Record the new cases red on `origin/main`.
- [ ] T2 Make the same change in `scripts/ci/pr-gate/lib.mjs`.
- [ ] T3 Run `node --test scripts/ci/pr-gate/__tests__/*.test.mjs` (the vitana-v1 PR-GATE command, `PR-GATE.yml:61`); save
      the output to `docs/validation/<VTID>/commands.log`.
- [ ] T4 `docs/validation/<VTID>/scope.json`: `kind: infra`, and the two paths of this lane.
- [ ] T5 PR titled `VTID-xxxxx (pr-gate-policy-sparring-record/policy-approval-record-v1): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — CI and developers: a vitana-v1 PR of a plan approved by policy shows the PR-GATE sparring check as passed.
  A record with no approval at all still fails it.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI and no user-visible string.
- **Contract** — n/a: the function's name, arguments and return value are unchanged. Only the accepted text changes.
- **Staging proof** — not verified on staging: the change deploys nothing. The covering tests are the PR-GATE node tests that
  vitana-v1 `PR-GATE.yml` runs on the PR head.
- **Reviewer** — no rule weakened, as for the platform lane. The two copies of the function stay identical.
- Diff only inside the lane `paths`; no test skipped or loosened.
