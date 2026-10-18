# Sparring responses — round 2

R2-F1 and R2-F2 are accepted and fixed in `plan.md`. R1-F1's dispute is accepted in full: the prose note
is replaced by a durable, pushed `executor: claude` lane (`lanes/spar-vitana-v1-ref.md`) that tracks the
PLAN-SPAR.yml change, and the plan block now **blocks this plan's `approved→executing` transition** until
that lane merges and the native plans re-spar with the vitana-v1 ref live.

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct. The test plan has every lane commit docs/validation/<VTID>/{scope.json,staging-tests.json,plan-sparring.md} at the vitana-v1 repo root (platform root for native-ci-workflow), which is not under apps/mobile/** and not the real-g1-switch G1-outcome dir docs/validation/g1/**, so Lane scope would fail all lanes. The lane FILES already carry docs/validation/VTID-*/{scope.json,staging-tests.json,plan-sparring.md} globs; the gap was that plan.md's path-ownership summary omitted them. Fixed: plan.md now lists docs/validation/VTID-*/** as a per-lane non-apps/mobile exception, states each lane's paths include the three VTID-* globs (VTID-* because CI assigns the VTID post-convergence), and notes real-g1-switch carries both its G1-outcome glob and its own-VTID validation globs."
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Correct \u2014 'workflow_dispatch-only (and native-path push)' was a contradiction and the runner type was unstated. Fixed: Decision 8 now states NATIVE-CI.yml triggers on push/pull_request filtered to apps/mobile/** PLUS workflow_dispatch, and every step runs on ubuntu-latest (offline Metro bundle + jest-expo; no simulator/device/macOS). So there is no macOS-runner cost and no overlap with MOBILE-DEVICE-E2E.yml (dispatch-only macOS, web app). The native-ci-workflow lane acceptance pins runs-on: ubuntu-latest so the implementer cannot write macos-15."
  },
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "The dispute is right: a prose note in plan.md is not a durable tracked artefact (collaboration \u00a71; CLAUDE.md rule 52 'deferred (where tracked)' requires a repository artefact). Fixed by adding lanes/spar-vitana-v1-ref.md \u2014 an executor: claude lane (governance path vitana-platform:.github/workflows/PLAN-SPAR.yml) that adds a pinned vitana-v1 checkout/extra_ref so the partner can read apps/mobile/**. It has its own lane file, and will carry its own branch/PR/VTID. The plan block now explicitly BLOCKS this plan's approved->executing transition until spar-vitana-v1-ref merges and the native plans are re-sparred with the vitana-v1 ref live \u2014 so no implementation lane ratifies an unverifiable premise. The create-session API and the partner's read_file/search_code tools already accept repo: exafyltd/vitana-v1 (PLAN_SPARRING_REPOS includes both repos); the only missing piece is the pinned ref in the session, which this lane adds.",
    "deferred_to": "lanes/spar-vitana-v1-ref.md (executor: claude). This plan is blocked from approved->executing until it merges and the native plans re-spar with the vitana-v1 ref live."
  }
]
```

## Note for the next round
All findings are now addressed in-repo, not in prose: R2-F1/R2-F2 in the plan block, R1-F1 as a tracked
`claude` lane that gates convergence. The remaining dependency (the actual PLAN-SPAR.yml ref change) is
Claude Code's to execute on its own lane; this plan correctly refuses to ratify its vitana-v1 premises
until that lands.
