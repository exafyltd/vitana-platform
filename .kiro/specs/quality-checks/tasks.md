# Tasks — quality-checks
Authoritative plan: `plan.md` (between the plan markers). Lane files: `lanes/pipeline-quality.md`,
`lanes/staging-manifest-bom.md`, `lanes/v1-pr-template.md`. VTIDs: allocated by CI PLAN-SPAR after policy approval;
never by hand. Branch `kiro/quality-checks/<lane>`, PR title `VTID-xxxxx (quality-checks/<lane>): …`, trailers
`Collab-Session` + `Collab-Lane` on every commit, identity `kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer,
evidence in `docs/validation/<VTID>/` (`commands.log` with every command and pass/fail counts, `red-on-base.txt` where
the lane has a test). Squash merge. Acceptance below is what the reviewer agent `vitana-lane-reviewer` checks.

<!-- lane: pipeline-quality -->
## Lane `pipeline-quality` — vitana-platform
- [ ] T1 Write `scripts/collab/quality-checks.test.mjs` (plan §4); record red on `origin/main` in
      `docs/validation/<VTID>/red-on-base.txt`.
- [ ] T2 Add `.kiro/pipeline/quality-checks.md` with the five parts of plan §3, each change-type item traced to a
      plan §2 evidence item (PR, commit or run).
- [ ] T3 One sentence each in `planning.md` §3, `lane-code.md` steps 7–9, `lane-review.md` ("What the review step's
      prompt gives the agent"), `lane-land.md` step 3d (squash); `## Verification` in `.github/pull_request_template.md`.
- [ ] T4 Local checks: the new test, `node --test scripts/collab/*.test.mjs`, `node --test
      scripts/ci/kiro-steering/guard.test.cjs`, `node scripts/ci/kiro-steering/guard.cjs .`, preflight; all in
      `commands.log`.

**Acceptance**
- Outcome: a planner, builder and reviewer reading the pipeline files find one place that says, per change type, what
  to state, check and prove, and what "verified" means.
- `quality-checks.md` has sections UI, Backend, Database, Integration, Infrastructure/CI, Tooling/docs; the Acceptance
  template has Outcome, States, Surfaces, Locales, Accessibility, Contract, Staging proof.
- No rule weakened: every existing step of `planning.md`, `lane-code.md`, `lane-review.md`, `lane-land.md` still
  holds; additions only (plus "squash" replacing "the method recent merged PRs use").
- The PR template's comment carries no VALIDATOR-CHECK marker word (`VALIDATION_PROFILE:` etc. appear only on their
  existing declaration lines).
- Only the lane's `paths` change; no protected gate file, `driver.md`, `preflight.mjs`, hook, guard or steering file.
- The new test fails on `origin/main`, passes on the head; asserts headings and links, not sentences.
- Deploys nothing.

<!-- lane: staging-manifest-bom -->
## Lane `staging-manifest-bom` — vitana-platform
- [ ] T1 Tests in `scripts/ci/staging-verify/lib.test.cjs` (plan §3/§4); red on `origin/main` recorded.
- [ ] T2 `parseJsonText` in `lib.cjs` (exported); `run.mjs` `loadManifest` uses it.
- [ ] T3 Local checks: `node --test scripts/ci/staging-verify/lib.test.cjs scripts/ci/staging-verify/workflow.test.cjs
      scripts/ci/staging-verify/confirm-live.test.mjs`, preflight; all in `commands.log`.

**Acceptance**
- Outcome: a `staging-tests.json` written with a UTF-8 BOM is read as the same manifest as without it, by `check-pr`
  and by STAGING-VERIFY.
- Edge states: invalid JSON still yields `__parseError`; only one leading U+FEFF is removed; empty input still fails.
- `validateManifest`, `planRange`, `decideOutcome` unchanged; no test changed or weakened.
- Only the lane's `paths` change. Deploys nothing.

<!-- lane: v1-pr-template -->
## Lane `v1-pr-template` — vitana-v1
- [ ] T1 Edit `.github/PULL_REQUEST_TEMPLATE.md` (plan §3).
- [ ] T2 Preflight on the head; record in `commands.log`.

**Acceptance**
- Outcome: a vitana-v1 PR opened from the template asks for the checks of its change type and no longer points at the
  dead Cloud Run preview.
- Every existing checklist item kept (only the preview line replaced).
- UI items: 1400×900 + 390×844 screenshots after the interaction or a stated reason; the phone code path named;
  de + ar/RTL; keyboard, labels, contrast; edge states; staging proof asserts the change; Commerce UX acceptance.
- Only the lane's `paths` change (vitana-v1). Deploys nothing.
