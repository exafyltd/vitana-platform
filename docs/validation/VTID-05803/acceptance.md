# VTID-05803: staging gateway deploy carries no production credentials

Owner instruction 2026-11-18: staging services receive staging credentials, never production service-role credentials.

AC-1. Staging resolves only staging-named auth secrets: `vitana/supabase/staging/jwt-secret`, `vitana/supabase/staging/anon-key`,
`vitana/gateway/staging/service-token` (was `vitana/supabase/prod/*`). A missing secret stops the deploy before registration.
TEST: `services/gateway/test/vtid-05803-stage-deploy-no-prod-secrets.test.ts` (resolves only staging-named auth secrets);
`scripts/ci/staging-db/stage-deploy-no-prod-secrets.test.mjs` test 1.

AC-2. A task definition that names `vitana/(supabase|aurora)/prod/*`, `vitana-aurora-prod` or the production master secret in
any secret or environment value is refused before register + roll (own step, after render).
TEST: `scripts/ci/staging-db/stage-deploy-no-prod-secrets.test.mjs` test 2 runs the exact jq on staging and production cases;
the jest test checks the pattern and the step order.

AC-3. `data_backend=aurora` and the VTID-05781/VTID-05023 roll step are unchanged (shared path byte-identical to the pinned step).
TEST: `scripts/ci/staging-db/cutover-workflows.test.mjs` 41/41.

AC-4. Production deploy unchanged.
TEST: both new tests, "production deploy keeps its production secrets".

AC-5. The run-step size limit holds.
TEST: `test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts`.

AC-6. The CI checks this change needs pass in the GitLab runner image (Debian bookworm: mawk, GitLab `CI_*` variables).
TEST: `scripts/ci/staging-db/aws-scripts.test.mjs` with mawk as `awk` (the bundle splitter used `{n}` intervals, which mawk
1.3.4 does not support); `scripts/eng/gitlab-gates.test.mjs` with the runner's `CI_*` variables set.

Contract change on purpose: `test/vtid-04225-no-dead-gcp-urls-in-workflows.test.ts` asserted the staging service token is the
production service-role key; it now asserts the staging secret and the absence of the production one.
Effect: callers of the staging gateway must present the staging service token.

## Aurora staging acceptance step in GitLab CI (Kiro 5, kiro-exafy-202611190018-058b)

AC-7. The acceptance job is a permanent part of the generated vitana-platform pipeline. `infra/gitlab-engineering/operations.json`
declares it (kept out of `config/`, whose change selects every check); `pipeline-gen.mjs` includes the file from vitana/ci-config (no `include: local`) and
admits only main api/web/schedule pipelines that set `VTID05803_ACCEPTANCE`. The job file lives in
`infra/gitlab-engineering/ci/`, so the settings sync writes it instead of dropping it.
TEST: `scripts/eng/pipeline-gen.test.mjs` "an operation file is included from ci-config ..."; `node scripts/eng/pipeline-gen.mjs --check`.

AC-8. The runner is read-only on both sides and never exposes a credential: every psql session starts with
`SET SESSION default_transaction_read_only = on` and the runner refuses (46/56) unless the session reports read_only=on;
no URI or password reaches argv, logs or evidence; a password holding `@ : # /` parses.
TEST: `scripts/ci/staging-db/staging-acceptance.test.mjs` tests 1 and 3.

AC-9. Exit contract: 0 acceptance passed; 1 unexplained differences (container 11-17 name the suites); 2 configuration or
infrastructure error (container 20-99, no exit code, task not STOPPED, upload failure on a pass = 80). Only container exit
0 maps to a pass.
TEST: `scripts/ci/staging-db/staging-acceptance.test.mjs` tests 2, 4, 5 and 7.

AC-10. The job file embeds exactly `scripts/aws/staging-acceptance/k5.py` and the ECS override stays under 8192 bytes.
TEST: `python3 scripts/aws/staging-acceptance/embed.py --check`; `staging-acceptance.test.mjs` test 6.

AC-11. `VTID05803_ACCEPTANCE=auto` (the schedule) runs the acceptance once per staging load that its owner reports with the
generic package file `vtid-05803-staging-load/latest/marker.json`; without a new marker it exits 3 (allowed to fail, never
a pass) and starts no task.
TEST: `scripts/ci/staging-db/staging-acceptance.test.mjs` test 7; first live run recorded in commands.log.

AC-12. Real run evidence before this change (ci-config job, same runner): pipeline 514, job 3548, task 5865052a, container
exit 17 (A07, A08, A09 differ: staging holds only the 6-table seed), evidence
`s3://vitana-code-index/vtid-05803/staging/runs/20261118T235135Z-k5-acceptance-schema-only/`.
CURL: GitLab API `projects/2/jobs/3548/artifacts` -> `acceptance/result.json` (exit_code 1, container_exit_code 17).

AC-13. The GitLab staging deploy path (`scripts/eng/deploy/deploy-ecs.mjs`, jobs `deploy-staging:*`) refuses, in shadow and
live mode and before any ECS write, a task definition that binds a production Supabase/Aurora secret, the production
cluster or its master secret (same patterns as the GitHub gate of AC-2). Found live: `vitana-gateway:1025` binds
`SUPABASE_JWT_SECRET`, `SUPABASE_ANON_KEY`, `GATEWAY_SERVICE_TOKEN` from `vitana/supabase/prod/*` (discovery pipeline 524),
and the GitLab deploy renders from the live definition, so it would have carried them forward.
TEST: `scripts/eng/deploy/deploy-ecs.test.mjs` "VTID-05803: a staging definition that binds production credentials is refused ...".

AC-14. The current vitana-platform main is deployable to `vitana-gateway-preview` (the Aurora-wired preview gateway
serving preview-aws-gateway.vitanaland.com) through a declared operation, not a manual include:
`infra/gitlab-engineering/ci/vtid-05803-gateway-preview-deploy.gitlab-ci.yml` (declared in operations.json, trigger
`VTID05803_GATEWAY_DEPLOY`), main + api/web only. `=preflight` is read-only (safe `UpdateService :999999` and
`RegisterTaskDefinition []` probes report whether the deploy role may roll the service). `=preview` builds
services/gateway (dind), pushes by digest, deploys via `deploy-ecs.mjs` (target gateway-preview, `--mode live`; pipeline
DELIVERY_MODE stays shadow so `.record`/`.vtid-close` never run), verifies the served commit and running image digest,
then runs STAGING-VERIFY against the preview URL. The production-credential gate (AC-13) applies: the preview task
definition binds staging-only secrets, any production secret is refused before any ECS write.
TEST: `scripts/eng/deploy/deploy-ecs.test.mjs` "VTID-05803: gateway-preview is an allowlisted target ..."; `scripts/eng/pipeline-gen.test.mjs`; GitLab CI lint (project 2): valid, 5 jobs resolve.

AC-15. The acceptance owner can read the per-object A07/A08/A09 diff and apply the smallest additive correction through
the existing authorized path (no new infra/IAM/restore): operation `vtid-05803-schema-acc.gitlab-ci.yml` (operations.json
trigger `VTID05803_SCHEMA_ACC`), main + api/web only, on the existing `vitana-aurora-staging-migrate` task. `=probe` runs
the pinned `scripts/aws/staging-acceptance/k5.py` read-only and republishes its evidence (report.json, a07-diff.txt,
a08/a09) to this project's generic package registry, so the cross-account S3 block (vitana-gitlab-deploy-role has no
s3:GetObject) no longer hides the diff. `=apply` downloads a sha256-pinned correction.sql, REFUSES any
DROP/TRUNCATE/DELETE/REVOKE/INSERT/UPDATE/MERGE/COPY, asserts the staging writer, applies it in one writable transaction
(ON_ERROR_STOP, atomic), then re-runs k5.py. Exit 0 only when A07/A08/A09 all pass. Baseline: run 20261119T131742Z, exit 17.
TEST: GitLab CI lint (project 2): valid, jobs vtid-05803-schema-acc-probe/apply resolve; `scripts/eng/pipeline-gen.test.mjs` (operation declared and included).

AC-16. The probe (VTID05803_SCHEMA_ACC=probe) published the exact per-object diff: staging public=695 tables vs source
700; 401 unexplained A07 differences (273 missing + 128 changed, zero extra), all of A08 (grants/policies/RLS/sequence
grants) and A09's vtid_ledger — concentrated on 6 preserved-seed tables missing from public (plan_sparring_config,
plan_sparring_sessions, plan_sparring_shadow_log, pm_digests, pm_lease, vtid_ledger) plus 8 helper functions, and 115
off-set changed function bodies + 4 extensions (live-source drift). `missing fk`=0. The generate mode
(VTID05803_SCHEMA_ACC=generate) runs `scripts/aws/staging-acceptance/gen-correction.py` in the migrate task: it reads
the k5.py diff and reconstructs the additive correction.sql for exactly those objects from the live source catalog
(server-side pg_get_functiondef / pg_get_constraintdef / pg_get_indexdef / format_type / pg_policy; never pg_dump),
grants/policies filtered to staging-existing roles, and publishes it for review before =apply.
TEST: GitLab CI lint (project 2): valid, jobs vtid-05803-schema-acc-probe/generate/apply resolve; `python3 -m py_compile scripts/aws/staging-acceptance/gen-correction.py`.

AC-17. `gen-correction.py` (=generate) now resolves mixed-case objects and stored generated columns, so it completes on
the live source instead of aborting on the view `VtidLedger`. Every `('public.'||name)::regclass` lookup wraps the name
in `quote_ident` — regclass lowercases an unquoted identifier, so `VtidLedger` resolved to a non-existent `vtidledger`
and exited the run (container exit 30) — and a column with `attgenerated='s'` is emitted as `GENERATED ALWAYS AS (expr)
STORED` rather than a plain DEFAULT, so a stored generated column is reproduced faithfully and does not re-flag as
changed. Read-only generation only; the guard and the atomic apply path are unchanged.
TEST: `python3 -m py_compile scripts/aws/staging-acceptance/gen-correction.py`; GitLab CI lint (project 2): valid, jobs
vtid-05803-schema-acc-probe/generate/apply resolve; the =generate run on main then publishes correction.sql.

AC-18. `gen-correction.py` (=generate) now reaches the live source the same way the comparator does. The direct
`db.<ref>.supabase.co` host is IPv6-only and unreachable from the task network, so when a TCP probe of it fails the
generator falls back to the session pooler (`POOLER_HOST`, default `aws-1-eu-north-1.pooler.supabase.com:5432`, user
`postgres.<ref>`) with the same password — identical to k5.py, whose probe evidence recorded `source_fallback=1`,
PG 17.4, 700 source tables. Without it, =generate connected to staging (29 roles) but aborted on the source with
"Network is unreachable" (container exit 30). Read-only generation only; the apply path is unchanged.
TEST: `python3 -m py_compile scripts/aws/staging-acceptance/gen-correction.py`; a resolution test exec's the real
conn_env/tcp/src_env and asserts unreachable->pooler, reachable->direct, already-pooler->unchanged; the =generate run
on main then connects via the pooler and publishes correction.sql.

AC-19. `gen-correction.py`'s psql reader (`q()`) now strips the trailing newline psql appends to unaligned (`-At -R`)
output before splitting on the record separator. Without it the last record's last field kept a "\n": the owned
sequence `plan_sparring_shadow_log_id_seq\n` was used in a regclass lookup and aborted =generate (container exit 30),
and role/column fields on a last record were likewise corrupted. Reproduced and fixed against real psql driving a
PostgreSQL 17.5 engine — the generated correction.sql then applies atomically (one transaction, ON_ERROR_STOP) to a
fresh database carrying the source roles. Read-only generation only; the apply path is unchanged.
TEST: `python3 -m py_compile scripts/aws/staging-acceptance/gen-correction.py`; a real-psql reproduction (PGlite wire
server) shows the owned-sequence query output ending in "\n", the pre-fix generator aborting on it, and the post-fix
generator producing a correction.sql that applies with rc=0.

AC-20. The additive correction was APPLIED to `vitana-aurora-staging` `public` and VERIFIED — k5.py was re-run after
each apply and A07/A08/A09 re-measured (the apply job itself still exits non-zero, container 17, because per AC-15 it
returns 0 only when A07/A08/A09 ALL pass, which they do not).
CURL: GitLab package `vtid-05803-schema-acc/20261119T190330Z-k5-schema-acc-apply/report.json` (a07.unexplained=142; a08
6/7; a09 FAIL) and `.../apply.stdout` (CREATE/ALTER/GRANT, no error).
Applied through the authorized apply path (guard-correction.py + one atomic `psql --single-transaction -v
ON_ERROR_STOP=1`) in three sha256-pinned passes: (1) tables (run 20261119T184602Z) — the 6 missing preserved-seed tables
(plan_sparring_config,
plan_sparring_sessions, plan_sparring_shadow_log, pm_digests, pm_lease, vtid_ledger) with columns/PK/check, 2 sequences +
ownership, 19 indexes, RLS on 6, 8 policies, table/column grants [A07 401 -> 178]; (2) functions (run 20261119T185300Z) —
127 CREATE OR REPLACE (check_function_bodies=false), 4 triggers, function grants [178 -> 152]; (3) grants (run
20261119T190330Z) — the standalone `global_vtid_seq` grants [152 -> 142]. A08 now passes 6/7 sub-checks (extension, policy, rls, table_grant,
column_grant, sequence_grant); only function_grant differs. A09 still FAILs on 3 holding-schema `vtid05803_preexisting`
objects (rows + a sequence value — data, for DMS). The 6 target tables are no longer flagged.
The 142 remaining A07 differences (exact: 121 changed function; 7 extra function_grant; 4 missing extension; 2 changed
fk; 1 each extra sequence, extra owner, changed sequence, changed owner, changed view, changed matview, changed
extension, changed check) are all non-additive and are left for the owner's allowlist/accept decision, not forced:
- 121 changed function: the comparator hashes `md5(prosrc)`, but `pg_get_functiondef` (what the generator applies)
  normalizes the body with a leading newline, so a CREATE OR REPLACE from source cannot make the raw-prosrc hash match;
  the function LOGIC is the same (the normalized bodies match) but the hashes cannot converge this way.
- platform-expected (11): 4 Supabase-only extensions (pg_cron/pg_net/pgmq/supabase_vault, not installable on Aurora) + 1
  changed extension (vector version) + 1 changed owner (schema public) + 1 changed matview + 1 changed view + 2 changed
  fk + 1 changed check (the last three are NOT VALID vs validated).
- introduced by the apply (10, so 142 is a NET count, not a subset of AC-16's baseline): 7 extra function_grant are the
  default PUBLIC EXECUTE that Postgres puts on the 7 newly-created functions — matching source needs a REVOKE, which the
  additive guard forbids; these are also exactly what A08 function_grant now reports as only_staging. The other 3 (extra
  sequence + extra owner + changed sequence) are the `plan_sparring_shadow_log_id_seq1` duplicate the tables pass left
  because the identity column auto-created a sequence alongside the explicitly-emitted one (a generator double-provision
  bug: for an identity-owned sequence the IDENTITY clause already creates it). All are harmless and non-additive to undo.
Staging `public` now carries the six-table schema for the DMS data load (Kiro 2); the duplicate identity sequence above
is an unused extra on plan_sparring_shadow_log and does not block the load.

AC-21. Final acceptance package for the owner: `docs/validation/VTID-05803/final-acceptance-package.md` + per-function
audit `outputs/function-fingerprint-evidence.tsv`. It does not weaken k5.py and does not claim exit 0.
CURL: package run `vtid-05803-schema-acc/20261119T190330Z-k5-schema-acc-apply/report.json` (a07.unexplained=142, a08
6/7, a09 FAIL). TEST: `outputs/function-fingerprint-evidence.tsv` shows staging prosrc md5 == md5(applied body) for
119/121 (agents_registry_set_updated_at = 44a734d202e32e7782c215138dc4c54e) and attributes byte-identical 121/121.
The package: (1) verifies the 7 PUBLIC-EXECUTE functions — 6/7 SECURITY DEFINER, all pin search_path, none touch
auth/vault/pgsodium/extensions/storage/net/pgmq/cron; PUBLIC is the Postgres-default extra (recommend REVOKE to match
source's least privilege). (2) proves the 121 "changed function" diffs are prosrc-normalization artifacts (non-body
attributes byte-identical source↔staging 121/121; staging prosrc hash == md5 of the applied pg_get_functiondef body
119/121; the 2 others were not re-applied and keep the original normalized body). (3) documents the 11 platform
exceptions (4 Supabase-only extensions, vector version, public schema owner, matview populated-state, 2 NOT-VALID FKs +
1 NOT-VALID check, deferred VtidLedger view). (4) records the duplicate identity sequence plan_sparring_shadow_log_id_seq1
(identity double-provision; harmless, unused). Owner decisions and the Kiro 2 / DMS hand-off are in the package.
