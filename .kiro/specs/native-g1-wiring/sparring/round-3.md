# Sparring round 3 — escalated

Session: `185a911c-d850-4c75-bdd6-89c59beb4e3a` · plan hash `4f6db7a74d23579a9f9e4779696657f9e7d1a8b8719834e6866e41457aeaa503`

## Summary

Round 3 review. The planner corrected the VTID-03506 citation (verified at CLAUDE.md lines 599-606) and accepted R2-F1 (relocated NATIVE-CI.yml into vitana-v1 where apps/mobile/ lives, eliminating the dead cross-repo trigger). The plan is largely internally consistent and its self-admitted limitation (current session is vitana-v1-blind; re-spar needed in a fresh session) is correctly modeled via the spar-vitana-v1-ref lane. One significant new governance risk is raised: the plan's justification for assigning the workflow lane to `executor: kiro` by treating `vitana-v1:.github/workflows/NATIVE-CI.yml` as "not a governance path" contradicts the collaboration rule, which lists `.github/**` (unqualified by repo) as a governance path and states the file is identical in both repos. This is unproven and likely to fail PR-GATE's Lane scope check.

## Findings

### R3-F1 [major]

The plan assigns `native-ci-workflow` to `executor: kiro` on the basis that `vitana-v1:.github/workflows/NATIVE-CI.yml` is 'the native app's own build pipeline' and 'not a vitana-platform governance file.' But the collaboration protocol lists `.github/**` as a governance path WITHOUT any repo qualifier, and explicitly states the file is 'identical in exafyltd/vitana-platform and exafyltd/vitana-v1.' A Kiro lane editing `.github/workflows/**` — in either repo — is exactly the 'change to a governance path … from a lane that is not executor: claude' that PR-GATE's Lane scope check is designed to fail. The plan offers no code citation proving that the governance-path rule is scoped to vitana-platform only; its entire rationale (Decision 8) rests on an asserted distinction the governing rule does not make.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:10` — This file is identical in `exafyltd/vitana-platform` and `exafyltd/vitana-v1`; the Kiro twin is `.kiro/steering/vitana-collaboration.md`.
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:100` — …any change to a governance path (`.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`, `CLAUDE.md`, `docs/programs/areas.yaml`) from a lane that is not `executor: claude`.

Suggestion: Either (a) make `native-ci-workflow` `executor: claude` / `reviewer_seat: claude` (as the plan itself does in Decision 7 before contradicting itself in Decision 8), or (b) provide concrete evidence — e.g. read vitana-v1's `.claude/rules/collaboration.md` and its PR-GATE config — proving that vitana-v1's Lane scope governance-path check excludes `.github/**` or is report-only and that the `.github/**` governance reservation is scoped to vitana-platform. The plan currently asserts this distinction without a single read of either vitana-v1 file, so the kiro-executor assignment is unproven governance risk. The internal contradiction between Decision 7 ('only native-ci-workflow touches a governance path … therefore executor: claude') and Decision 8 ('NATIVE-CI.yml is not a vitana-platform governance file … executor: kiro') must also be resolved in one direction with evidence.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Planner accepted the dead cross-repo trigger defect and fixed it by relocating NATIVE-CI.yml to vitana-v1 (where apps/mobile/ lives), with push/pull_request path-filters to apps/mobile/**, workflow_dispatch, and no cross-repo checkout (the workflow checks out its own repo). The MOBILE-DEVICE-E2E.yml distinction (dispatch-only macOS web-in-Safari) is verified at lines 23-24 and 41-43. Resolved.
