# VTID-05023 agent A: gate proof

Branch: `cutover/vtid-05023-A-gate-proof` (from `origin/main` a02b8918f3).

## 1. Why the gate line never printed

Job 1280 (pipeline 279, commit a02b8918f3) is the deploy job the brief names. Pipeline 279 also has a manual retry of the same job, 1296. Both traces show the same sequence: `Rollback target`, `New task definition`, `Smoke OK`. Neither has an `Aurora gate` line.

Evidence:

- Pipeline 279 has `ci_config_path: platform.gitlab-ci.yml@vitana/ci-config:main`. The project `vitana/vitana-platform` (id 2) has no root `.gitlab-ci.yml`. The pipeline reads its config from project `vitana/ci-config` (id 1). The `local:` include `staging-gateway-deploy.gitlab-ci.yml` resolves inside `vitana/ci-config`, not inside this repo.
- The copy in `vitana/ci-config` is refreshed by the settings sync (`scripts/eng/gitlab-settings.mjs`). The ci-config commit history shows:
  - `1b1044febb` (2026-11-11): no strip and no gate in `staging-gateway-deploy.gitlab-ci.yml`.
  - Pipeline 279 was created at 2026-11-12 13:49:10 UTC, while ci-config still held `1b1044febb`.
  - `546bf3f876` (2026-11-12 13:56:13 UTC, "sync staging-gateway-deploy ... from infra/gitlab-engineering/ci"): first copy with the strip and echo. It came 7 minutes after pipeline 279 was created.
- Pipeline 279 therefore ran the pre-MR job definition. That definition neither stripped the Aurora names nor printed a gate line. Job 1280 registered revision 1010 with whatever bindings the old definition copied from revision 1009.
- The repo has exactly one definition of `gateway-staging-deploy` (`infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml`, job at line 52). No second definition, no YAML anchor, and no `extends:` target collides with it. `platform.gitlab-ci.yml` in the repo and in ci-config are identical and include only that one file.
- Current ci-config `staging-gateway-deploy.gitlab-ci.yml` (sync `546bf3f876`, and `6d78dfbf7f` for the platform file) matches the repo copy byte for byte, and contains the strip and the old echo.

Root cause: the pipeline runs the ci-config copy, and that copy was stale when pipeline 279 was created. The echo was never in the job that ran.

Not established: whether revision 1010 still binds `AURORA_` names. The sandbox role gets `AccessDeniedException` on `ecs:DescribeTaskDefinition` and `ecs:DescribeServices`, so I could not read it. Owner check, read-only:

```
aws --region eu-central-1 ecs describe-task-definition --task-definition vitana-gateway:1010 --query 'taskDefinition.containerDefinitions[].{c:name,env:environment[].name,sec:secrets[].name}' --output json
```

## 2. Change in this MR

- `infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml`:
  - Gate prints `VTID-05023 AURORA GATE: PASS no AURORA_ names` on its own line, and writes that line to `aurora-gate.txt` (through `tee`).
  - On a leak it prints `VTID-05023 AURORA GATE: FAIL <names>` to the same file and exits 1 before `register-task-definition`.
  - Job has `artifacts: paths: [aurora-gate.txt]`, `when: always`, `expire_in: 1 week`.
  - The strip jq and the leak-check jq are unchanged.
- `services/gateway/test/vtid-05023-gitlab-gate-line.test.ts` (new): reads the job with js-yaml. Checks the PASS and FAIL echo lines, the order (gate before `register-task-definition`), the artifact path and `when`. Runs the gate block in bash with jq on a clean and a leaking task definition and checks stdout and the artifact.
- The existing `vtid-05023-gitlab-aurora-strip.test.ts` and the vtid-05005 test are not changed.

Note on the sync: after this MR merges, the ci-config copy only updates when the settings sync runs. A pipeline created before that sync runs the old file again. Check before triggering the deploy:

```
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.vitanaland.com/api/v4/projects/1/repository/files/staging-gateway-deploy.gitlab-ci.yml/raw?ref=main" | grep -c 'VTID-05023 AURORA GATE'
```

Expected output `2`. Create the deploy pipeline only after that.

## 3. Tests

Before (unchanged file), `npx jest test/vtid-05023-gitlab-gate-line.test.ts test/vtid-05023-gitlab-aurora-strip.test.ts`:

```
✓ removes the three Aurora names from environment and secrets of every container
✓ gate prints any AURORA_ name still bound in any container, and nothing for a clean task definition
✕ prints the PASS line with the fixed prefix and writes it to aurora-gate.txt
✕ prints the FAIL line with the fixed prefix and the names, writes it to aurora-gate.txt, and exits 1
✕ prints the gate before the task definition is registered
✕ uploads aurora-gate.txt as a job artifact, also when the job fails
✕ a clean task definition passes: the PASS line is on stdout and in the artifact, exit 0
✕ a task definition that still binds AURORA_ names fails: the FAIL line lists them, exit 1
Tests: 6 failed, 2 passed, 8 total
```

After (this commit), same command:

```
✓ removes the three Aurora names from environment and secrets of every container
✓ gate prints any AURORA_ name still bound in any container, and nothing for a clean task definition
✓ prints the PASS line with the fixed prefix and writes it to aurora-gate.txt
✓ prints the FAIL line with the fixed prefix and the names, writes it to aurora-gate.txt, and exits 1
✓ prints the gate before the task definition is registered
✓ uploads aurora-gate.txt as a job artifact, also when the job fails
✓ a clean task definition passes: the PASS line is on stdout and in the artifact, exit 0
✓ a task definition that still binds AURORA_ names fails: the FAIL line lists them, exit 1
Tests: 8 passed, 8 total
```

Typecheck (`npm ci` then `pnpm run typecheck`, as the CI comment in `platform.gitlab-ci.yml` describes): exit 0.

## 4. Expected result of the next deploy

- Log line: `VTID-05023 AURORA GATE: PASS no AURORA_ names`
- Job artifact: `aurora-gate.txt`, containing that same line.
- On a leak the line is `VTID-05023 AURORA GATE: FAIL <names>`, the job exits 1, and nothing is registered.

## 5. Owner actions

1. Merge the MR, then run the `curl` check in section 2. Expect `2`. Stop if it prints `0`.
2. Read revision 1010 with the `aws` command in section 1, and record whether it still binds `AURORA_` names. Revision 1010 came from the pre-MR job, so it is expected to bind them.
3. Trigger the deploy after step 1. The owner or the lead agent triggers it; this run did not deploy.
