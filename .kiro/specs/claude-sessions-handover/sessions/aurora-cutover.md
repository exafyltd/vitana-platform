# D - Aurora cutover (session_018ddU3rqdDwWRNjMCYZ4bGb)
- Created 2026-10-01 07:24 / updated 2026-10-13 22:36 UTC; status idle (bucket blocked). Branch `claude/jolly-wozniak-gueg67` in both repos.
## Goal
Migrate the platform database from Supabase to Aurora ("option B", VTID-05023), ending with a production cutover.
## Done
- exafyltd/vitana-platform#4003 merged 2026-10-13 19:33 UTC (merge b3a5aca; verified via GitHub): phase B, auth bridge (Supabase Auth stays, new members provisioned on Aurora), 21 cron jobs to Aurora pg_cron, outbox replacing pg_net, self-hosted Realtime on Aurora (dispatch-only AWS-PROD-DEPLOY-REALTIME-AURORA.yml), migration runner to Aurora, storage-auth CDC, `data_backend` input (keep/supabase/aurora) on deploy workflows. Follows #3830 (phase A, not re-checked).
- Staging verified: b3a5aca checked as part of f3bcf3d, run 38468802774, 91/91 tests passed, 14/14 cutover checks passed (auth-bridge 401 probe, realtime, reverse-copy, migration, rehearsal-clone).
- Production unchanged: every switch is off.
## State now
- No open PR seen. Cutover waits on the owner. Whether check-in routines remain armed is unknown.
## Blocked on / needs owner
In AWS CloudShell: run `bash scripts/aws/iam/vtid-05023-iam-check.sh <deploy-role>` (role behind AWS_PROD_ROLE_ARN; read-only), attach missing policies from `scripts/aws/iam/` (two policy files), add the port 4000 security-group rule for realtime, create the Cloudflare token, paste output. Then the session runs the rehearsal on an Aurora clone copy, asks for the production go-ahead, and proposes a switch time.
## Next steps for Kiro
1. Nothing writes to prod. Ask owner for the IAM check output (owner-only step).
2. After output: rehearsal on a copy of Aurora, report results (read-only analysis; scripts under scripts/aws/).
3. Claude-Code/owner only: production go-ahead, the actual switch, any prod deploy (AWS-PROD-DEPLOY-* pinned to a verified commit), data_backend=aurora flips.
## Gotchas/lessons
- Several STAGING-VERIFY runs showed "success" with 0 tests because they were superseded; only count a run whose log shows tests actually ran (here run 38468802774).
- GitHub Actions queue was heavily backed up (84 queued at one point).
- Supabase `postgres` role cannot SET session_replication_role, so reverse CDC disables Supabase user triggers instead (snapshot + rollback).
- Prod gateway workflow is at GitHub's 25-input limit.
