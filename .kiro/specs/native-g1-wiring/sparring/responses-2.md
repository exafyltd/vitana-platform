# Sparring responses — round 2

R2-F1 and R2-F2 are accepted and fixed in `plan.md`. (R1-F1 is a round-1 finding and is addressed in the
plan text — see the "R1-F1" paragraph and the `spar-vitana-v1-ref` lane in `plan.md`; it is not re-answered
here, since this file answers only round-2 findings.)

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
  }
]
```

## Note for the next round
R2-F1 and R2-F2 are resolved in the plan block. R1-F1 (round 1) remains tracked in the plan text as the
`spar-vitana-v1-ref` lane, which gates this plan's `approved→executing` transition; the current session's
refs are pinned and cannot read vitana-v1, so if R1-F1 is still disputed this session escalates and a new
session opens after the ref fix merges.
