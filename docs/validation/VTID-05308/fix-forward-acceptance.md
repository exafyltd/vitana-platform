# VTID-05308 — fix-forward acceptance (ci-github-modernization/fix-staging-test-regressions)

Lane `ci-github-modernization/fix-staging-test-regressions`. Fixes three gateway Jest regressions introduced when the
ci-github-modernization lanes (stale-tests, ci-health) were merged to `main` before the reviewer verified them end to
end. CI-only / test + spec + validation-manifest changes; deploys nothing; read-only (no staging/production probe
from this session, CLAUDE.md rule 48).

This file is specific to the fix-forward lane. The pre-existing `docs/validation/VTID-05308/acceptance.md` records the
stale-tests lane's own acceptance and is left unchanged.

AC-1 The VTID-04659 guard is green: no staging http check reads a versioned Command Hub asset at its BARE URL. The
svg-preview.js check in `docs/validation/VTID-05082/staging-tests.json` now reads the versioned URL
`/command-hub/svg-preview.js?v=20261121-vtid-05082` that `index.html` serves (line 29), so it is not equal to the bare
asset path the guard extracts.
TEST: `jest test/vtid-04659-staging-checks-use-versioned-urls.test.ts` — PASS (both cases green).

AC-2 The loop catalog coverage rule is green: the scheduled workflow `CI-HEALTH` (`.github/workflows/CI-HEALTH.yml`,
`schedule: 17 5 * * *`) is owned by exactly one loop — L2 Build & Release — in
`services/gateway/specs/loop-catalog-v1.json`. No workflow is orphaned or double-owned.
TEST: `jest test/loop-catalog.test.ts` — PASS (27/27, including *workflows: no orphans, nothing owned twice*).

AC-3 The VTID-04868 CLAUDE.md contract case is green: CLAUDE.md still carries rules 51-55, the
`Plan → sparring → owner approval … → VTID → code.` flow, `Claude Opus 4.6 on AWS Bedrock`, the fallback chain,
`deepseek-v4-pro` and `Never Google.`. The assertion that pinned the VTID-05280-removed line
`Step 0 (VTID-04868): spar the plan first.` is repointed at the durable §4.1 wording
(`### 4.1 Allocation (STANDING RULE — VTID-03448, VTID-04868)` + `allocated only after its plan is sparred and
approved`), preserving the "allocation after sparring" intent without weakening it. CLAUDE.md (a protected gate file)
is not modified.
TEST: `jest test/vtid-04868-plan-sparring-session-layer.test.ts -t "CLAUDE.md carries rules 51-55"` — PASS.

AC-4 No test is deleted or weakened. One assertion is repointed (vtid-04868), one staging-check `path` is versioned
(VTID-05082 manifest), one workflow owner is added (loop catalog). The renderer `expect_body_contains` and the reason
on the VTID-05082 check are unchanged.
TEST: PR-GATE test-weakening guard (cases/expects/skips unchanged except the one repointed vtid-04868 assertion).

## Note on the two local-only failures in vtid-04868
`vtid-04868-plan-sparring-session-layer.test.ts` also has two hook cases that `execFileSync('bash', …)` the
`.claude/hooks/pretooluse-plan-sparring-reminder.sh` script. That script requires `jq`, which is not installed on the
Windows dev machine (and `bash` resolves to the WSL stub with no distro), so those two cases fail **locally only**.
They are untouched by this lane, unrelated to the merged lanes, and pass on CI's ubuntu-latest runner where `jq`
exists. The CLAUDE.md case — the one that was the real regression — passes.
