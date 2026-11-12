# VTID-05023 agent D: window runbook note

Branch: `cutover/vtid-05023-D-window-runbook` (from `origin/main` at `a02b8918f38a57f7b0b6910a365e2a70629d6b89`).
Output: `docs/validation/VTID-05023/window-runbook.md`.

## What was done

- Read handover Part 4 and Part 5 from `docs/handover/VTID-05023/KIRO-HANDOVER.md` on `cutover/vtid-05023-handover`, through the GitLab file API.
- Read `other-services.md`, `storage-auth.md`, `plan-sparring.md` parts 11 and 12, and `rehearsal.md` sections G and J, for the step order, commands and watch thresholds.
- Wrote the seven steps in the brief's order (freeze, final copy, migrations, REST switch, checks, two-hour watch, rollback), with a "Not in this window" section and a TODO list.
- Every production step carries the line `Owner command required`. Nothing was executed.

## Conflicts with the brief

1. Final-copy method. The brief says "pg_dump snapshot plus the storage-auth DMS scope". The handover names "Aurora final copy" and "DMS start" and no pg_dump. The runbook follows the handover and marks the method for owner confirmation.
2. `DATA_REST_BASE_MODE=aurora_proxy` is not on `main`. The handover and `other-services.md` use `DATA_REST_URL`. The runbook lists both and marks the setting TODO.
3. `MIGRATION_FREEZE=true` blocks `RUN-MIGRATION.yml`, so the freeze in step 1 and the migrations in step 3 conflict. Owner decision.
4. `AWS-PROD-DEPLOY-GATEWAY.yml` with `deploy_mode=env-only` does not pin a commit. The handover requires the gateway pinned to the verified commit.
5. `scripts/cutover/verify-cutover.sh` returned `404 Commit Not Found` on branch `gitlab-migration-prep` in project 2 (GitLab API check). It is a blocker for step 2e.

## Not read or not found

- `migration-order.md`: agent G's branch. Cited by path only. Pending owner confirmation O5.
- Prod gateway URL, sample `/rest/v1` table and column, watch dashboards, DMS start and stop commands, workflow names for verification-engine, orb-agent and autopilot-executor, and the psql invocations for the Supabase scripts. None of these is defined in the handover or the repo. All are listed as TODO in the runbook.

## Commands

No commands were run against production, AWS, Supabase, Aurora or DNS. Reads were limited to GitLab API file reads and local file reads and searches in the cloned repo.
