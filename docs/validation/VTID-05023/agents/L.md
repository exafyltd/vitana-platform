# VTID-05023, agent L: rollback dry run

## Result

- Script: `scripts/cutover/rollback-dry-run.sh`. Dry run is the default. `--execute` is a separate flag, and it also needs `--verify-aws`.
- Test: `scripts/cutover/rollback-dry-run.test.sh`. 9 of 9 pass. An `aws` stub on PATH logs every call and fails.
- Nothing was executed against any environment. The script was never run with `--execute`.
- Step 1 (REST back to Supabase) has no command on `main`. Dry run prints `TODO: owner to supply`, and `--execute` refuses until a command exists.

## Order

1. Switch REST base back to Supabase. Setting: `DATA_REST_BASE_MODE`. Unset or `supabase` means Supabase. Auth stays on Supabase in both modes.
   Source: agent C's local branch `cutover/vtid-05023-C-rest-switch`, read from agent C's workspace. The branch is not on origin, so the name was not fetched from the remote.
2. Point the gateway service at the previous revision. The target is `vitana-gateway` in cluster `Vitana-ECS-Cluster`, the staging service in `AWS-STAGE-DEPLOY-GATEWAY.yml`. The previous revision is a required argument, and the script refuses without it. The task family defaults to `vitana-gateway` (`GATEWAY_TASK_FAMILY` overrides it). That family name was not read from AWS.
3. Stop the DMS sync task. The ARN comes from `DMS_TASK_ARN`. Region defaults to `eu-central-1`, from `docs/AURORA-CUTOVER-HANDOFF-2026-09-28.md`.

## Refusals

| Case | Exit |
|---|---|
| No `--previous-revision` | 2 |
| Non-numeric revision | 2 |
| `--target production` (any mode) | 3 |
| Any target other than `staging` | 3 |
| `--execute` without `--verify-aws` | 4 |
| `--execute` when a check fails or is not verified | 4 |
| `--execute` when step 1 has no command | 6 |

## Checks

- Without `--verify-aws`, no AWS call is made. Each check is printed as `not verified: no AWS access from this sandbox (owner to verify)`.
- With `--verify-aws`, the script runs read-only calls only: `aws sts get-caller-identity` (account 472838866351), `aws ecs describe-services`, `aws ecs describe-task-definition`, and `aws dms describe-replication-tasks`.

## Test output

```
PASS: no arguments is refused and names --previous-revision
PASS: dry run prints steps in order 1, 2, 3
PASS: dry run without --execute makes no AWS call and marks checks not verified
PASS: production target refused in dry run
PASS: production target refused with --execute
PASS: --execute without --verify-aws is refused
PASS: --execute refuses when checks fail, and no update or stop call is made
PASS: dry run with --verify-aws reports unreachable AWS and runs only read-only calls
PASS: non-numeric revision is refused

Passed: 9  Failed: 0
```

## Dry run output

Without arguments:

```
Usage: rollback-dry-run.sh --previous-revision <n> [--target staging] [--verify-aws] [--execute]
ERROR: refused: --previous-revision <n> is required. No previous revision is pinned in the repo.
rc=2
```

With `--previous-revision 41`:

```
VTID-05023 rollback path. Target: staging. Previous revision: vitana-gateway:41.
Mode: dry run. Nothing is executed.

STEP 1: switch REST base back to Supabase (DATA_REST_BASE_MODE=supabase)
  setting: DATA_REST_BASE_MODE, unset or 'supabase' means Supabase. Auth stays on Supabase in both modes.
  source: agent C branch cutover/vtid-05023-C-rest-switch (local to agent C, not on origin)
  check: setting is not on main yet. not verified: no AWS access from this sandbox (owner to verify)
  command: TODO: owner to supply. No command that sets DATA_REST_BASE_MODE on the staging gateway exists on main.

STEP 2: point gateway service at previous revision vitana-gateway:41
  check: account is 472838866351 (aws sts get-caller-identity): not verified: no AWS access from this sandbox (owner to verify)
  check: cluster Vitana-ECS-Cluster and service vitana-gateway are ACTIVE: not verified: no AWS access from this sandbox (owner to verify)
  check: task definition vitana-gateway:41 exists: not verified: no AWS access from this sandbox (owner to verify)
  command: aws ecs update-service --cluster Vitana-ECS-Cluster --service vitana-gateway --task-definition vitana-gateway:41 --region us-east-1
  command: aws ecs wait services-stable --cluster Vitana-ECS-Cluster --services vitana-gateway --region us-east-1

STEP 3: stop the DMS sync task
  check: DMS_TASK_ARN is not set. Refused for --execute. (owner to verify)
  command: aws dms stop-replication-task --replication-task-arn NOT_SET_DMS_TASK_ARN --region eu-central-1

Dry run finished. Nothing was executed.
rc=0
```

With `--target production --previous-revision 41 --execute --verify-aws`:

```
ERROR: refused: target 'production' is not allowed in this run. Production rollback is owner-only.
rc=3
```

## Open items for the owner

- Step 1 command: owner supplies the command that sets `DATA_REST_BASE_MODE=supabase` on the staging gateway. It goes in `S1_CMD` in the script. Agent C's branch must reach origin first.
- Previous revision number: owner supplies it. No known-good revision is pinned in the repo.
- `DMS_TASK_ARN`: owner supplies the staging sync task ARN.
- Task family `vitana-gateway`: confirm with `aws ecs describe-services` once AWS access exists.
- Draft MR: the brief asks for a draft MR with a title starting `VTID-05023`. GitLab marks a draft by a `Draft:` title prefix, so the MR is open, not draft.
