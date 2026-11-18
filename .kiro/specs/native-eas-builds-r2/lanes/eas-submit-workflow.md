---
lane: eas-submit-workflow
state: ready
next_actor: kiro
depends_on: [eas-build-workflow, store-owner-gate]
executor: kiro
area: frontend
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - .github/workflows/NATIVE-EAS-SUBMIT.yml
  - apps/mobile/eas.json
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:11Z
vtid: VTID-05667
---
# TestFlight internal and Play internal track upload for `test-g1` (decisions 7, 8, 9, 10)
Plan: `.kiro/specs/native-eas-builds-r2/` — `plan.md` and the `tasks.md` section marked `<!-- lane: eas-submit-workflow -->`
are authoritative. VTID: assigned by CI after PLAN-SPAR converges;.

**Governance path (`.github/**`), not a protected gate file.** Built by a Kiro seat, reviewed by the reviewer agent.

**Goal.** Two parts in one PR.
1. `apps/mobile/eas.json`: add a `submit` block with only a `test-g1` entry. It holds store identifiers and the
   track, `ios` (App Store Connect app id, from O2) and `android` (`track: internal`, from O3), and no credential.
   No `production` key.
2. `.github/workflows/NATIVE-EAS-SUBMIT.yml`: `workflow_dispatch` only, input `platform` (choice `ios`, `android`).
   Its first step refuses any profile other than `test-g1` and any track other than `internal`. It then runs
   `eas submit --profile test-g1 --platform <platform> --latest --non-interactive`, with the `EXPO_TOKEN` secret.
   The submit step reads the store credentials from EAS, never from the repository.

**Acceptance (reviewer = agent:vitana-lane-reviewer):**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: after O1–O5, a `test-g1` build appears in TestFlight under the internal group and as a Play internal
  release. Before O2 and O3 the lane is merged but not run.
- `eas-profile-guard` passes with the new `submit` block (only `test-g1`, only `track: internal`).
- The workflow runs no other profile or track. It has no `push` or `schedule` trigger, and it never uses an external
  TestFlight group or a Play track above internal.
- Store identifiers may sit in `eas.json`; no secret, key path or token does.
- Staging proof: not verified on staging: the store upload is verified on the store's internal track only (the build
  appears in App Store Connect / TestFlight, and the Play internal release has its version code).
- Contract: EAS Submit command with `--profile test-g1`, `--platform`, `--latest`, `--non-interactive`; errors fail the job.
- `docs/validation/<VTID>/{scope.json, staging-tests.json, plan-sparring.md}` added; `staging-tests.json` is read-only.

**Never** (collaboration §7a and plan Decisions 7–9): no submit of `production` or any non-internal track; no upload before
O4 and O5 name the testers; no VTID allocation, no merge or approval by the builder, no write to Supabase, AWS, the
gateway or any production system.

## Log
### 2026-11-08T11:48Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-eas-builds/eas-submit-workflow`, PR #4771).

### 2026-11-08T12:11Z · ci-plan-spar · ready (VTID allocated)
VTID-05667 allocated after policy approval (converged-auto-v1).
