# VTID-05356 acceptance (pipeline-agent-wake-and-review/review-fallback-trailer, tasks.md T1-T3)

Every AC maps to a TEST: within 12 lines. Raw output: `outputs/red-on-base.txt`. Commands: `commands.log`.
Change types: Backend (PM observer). Deploys the gateway to staging.

AC-1 `ReviewEntry` gains `fallback_reason?: string | null`; a review commit's `Collab-Fallback-Reason` trailer is
parsed into it next to `Collab-Reviewer` / `Collab-Reviewed-Head` (present → value, absent → null, any value kept
verbatim, a log entry merged with its trailer commit takes the trailer value).
TEST: npx jest test/project-manager/observe-live-fallback-reason.test.ts

AC-2 No PM decision changes: nothing reads the field in this lane; every existing PM suite and the operator pipeline
regression stay green; the gateway type-checks.
TEST: npx jest test/project-manager; npx jest test/vtid-04465-operator-pipeline-regression.test.ts; npx tsc --noEmit

AC-3 The staging proof is read-only (gateway alive, PM mode endpoint, PM jest suite).
TEST: docs/validation/VTID-05356/staging-tests.json (validateManifest ok)
