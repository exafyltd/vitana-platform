---
lane: eas-build-workflow
state: ready
next_actor: kiro
depends_on: [eas-profile-guard]
executor: kiro
area: frontend
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - .github/workflows/NATIVE-EAS-BUILD.yml
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:11Z
vtid: VTID-05665
---
# Manual EAS cloud build workflow for `development` and `test-g1` (decisions 1, 2, 4, 8)
Plan: `.kiro/specs/native-eas-builds-r2/` — `plan.md` and the `tasks.md` section marked `<!-- lane: eas-build-workflow -->`
are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Governance path (`.github/**`), not a protected gate file.** The lane is built by a Kiro seat and reviewed by the
reviewer agent (`reviewer_seat: agent:vitana-lane-reviewer`), as `validateLane` allows. It must not change any other
workflow.

**Goal.** A new `.github/workflows/NATIVE-EAS-BUILD.yml`, triggered by `workflow_dispatch` only, with two inputs:
`profile` (choice: `development`, `test-g1`) and `platform` (choice: `ios`, `android`). It runs
`npx eas-cli build --profile <profile> --platform <platform> --non-interactive` in `apps/mobile` on `ubuntu-latest`,
using the `EXPO_TOKEN` secret. The build runs on EAS workers, so the job uses no macOS minutes. It prints the build
URL and the commit SHA, and it does not submit anything.

**Acceptance (reviewer = agent:vitana-lane-reviewer):**
- Change types: Infrastructure/CI.
- Outcome: the owner or Kiro starts an EAS build for `test-g1` on Android from the Actions tab and gets a build URL.
  iOS runs only after O1 and O2 exist. Nothing else is built or uploaded.
- The workflow has no `push`, `pull_request` or `schedule` trigger, and no `production` choice exists.
- No `secrets.` in an `if:`; the secret is passed through `env`. No secret, token or key value is written to a file or
  the log.
- Inputs are restricted to the two choice lists above. Nothing else is interpolated into the shell command.
- Not a required check; the file is parsed in CI (YAML) and the run is linked in the PR.
- Staging proof: not verified on staging: a native build has no staging deploy; verified by the EAS build URL with status
  finished for the dispatched commit (before O1 this is "not verified: waits for O1").
- Contract: EAS CLI build command with `--non-interactive`; `apps/mobile/eas.json` profile names match
  `development`/`test-g1` (checked by `eas-profile-guard`).
- `docs/validation/<VTID>/{scope.json, staging-tests.json, plan-sparring.md}` added; `staging-tests.json` is read-only.

**Never** (collaboration §7a): no VTID allocation, no merge or approval by the builder, no `eas submit`, no upload to a
store, no write to Supabase, AWS, the gateway or any store, no test against production.

## Log
### 2026-11-08T11:48Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-eas-builds/eas-build-workflow`, PR #4771).

### 2026-11-08T12:11Z · ci-plan-spar · ready (VTID allocated)
VTID-05665 allocated after policy approval (converged-auto-v1).
