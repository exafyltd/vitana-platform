# Sparring round 2 — in_progress

Session: `92c6fbcd-fe6a-42c0-ac74-468c11b2fc50` · plan hash `fc1e1e795d0f0ff4678090fbe46af56a3a903d17a3499caeb64692fbf766b9f9`

## Summary

The four accepted findings from Round 1 are materially addressed in the revised plan: R1-F1 now uses an allow-list with drift check, R1-F2 specifies bootstrap behavior with post-merge verification, R1-F3 corrects the attribution (mostly — see R2-F2), and R1-F4 adds explicit denies on secret read/write. Two new issues surfaced during Round 2 verification: the production migration infrastructure is hardcoded to production values in ways the plan doesn't acknowledge, and the R1-F3 correction introduced a new wrong citation.

## Findings

### R2-F1 [major]

The plan's `staging-migrations-auto` lane adds a `staging` target to `RUN-MIGRATION.yml` that 'resolves only to the isolated cluster.' But the underlying script `aurora-apply-migration.sh` hardcodes `CLUSTER=vitana-aurora-prod` at line 37 and the `RUN-MIGRATION.yml` Aurora job assumes `secrets.AWS_PROD_ROLE_ARN` at line 151. The plan does not note these hardcoded production values. If the new staging target calls the same script or assumes the same role, the migration would reach the production cluster or run with production-level credentials. The lane includes the script in its paths, and the test says 'target staging never resolves to a production cluster', but without an explicit plan to parameterize the cluster name and the IAM role, the implementation could silently reuse either.

- `exafyltd/vitana-platform:scripts/aws/aurora-apply-migration.sh:35` — R=eu-central-1
ACCOUNT=472838866351
CLUSTER=vitana-aurora-prod
DB=vitana
- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:148` — - name: Configure AWS credentials (GitHub OIDC — no static keys)
          uses: aws-actions/configure-aws-credentials@v4
          with:
            role-to-assume: ${{ secrets.AWS_PROD_ROLE_ARN }}
            aws-region: ${{ env.AWS_REGION }}

Suggestion: The plan should explicitly note that `aurora-apply-migration.sh` hardcodes `CLUSTER=vitana-aurora-prod` and the Aurora migration job uses `secrets.AWS_PROD_ROLE_ARN`. Specify that the staging target must: (a) parameterize the cluster name in the script (e.g., accept `--cluster` or read from an env var, defaulting to `vitana-aurora-staging` for target `staging`), and (b) assume a staging-only IAM role (the new `kiro-staging-operator` or a dedicated staging migration role), never `AWS_PROD_ROLE_ARN`. The staging-prod-ref-guard should also scan the `aurora-apply-migration.sh` invocation path for production cluster names.

### R2-F2 [minor]

The R1-F3 correction introduced a new wrong citation. H5 now says '`next_actor: owner` in `.kiro/pipeline/driver.md:52` and `common-rules.md:30`'. `driver.md:52` is correct (it says `next_actor: owner`). But `common-rules.md:30` says 'The owner is asked exactly one question per plan: Gate 2. The only other stops are an escalated sparring verdict and the §7 stop cases (security or data-loss risk, the same failure surviving 3 fix attempts → park with the five-part stop message, anything that would reach production).' It mentions parking with the five-part stop message but does NOT say `next_actor: owner`. The plan should not attribute `next_actor: owner` to that line.

- `exafyltd/vitana-platform:.kiro/pipeline/common-rules.md:30` — 5. **Autonomy.** The owner is asked exactly one question per plan: Gate 2. The only other stops are an escalated
   sparring verdict and the §7 stop cases (security or data-loss risk, the same failure surviving 3 fix attempts →
   park with the five-part stop message, anything that would reach production). Git, push, PR, merge, re-runs,
   sparring rounds and VTIDs never need the owner.
- `exafyltd/vitana-platform:.kiro/pipeline/driver.md:51` — 3. **Fix forward** a lane whose PR head has a failed check: read the log, fix inside the lane's `paths`, run preflight, then push. At most
   3 attempts per lane; the 4th failure parks the lane (`parked`, `parked_from`, `next_actor: owner`) with the
   five-part message.

Suggestion: Remove `common-rules.md:30` from the H5 citation for `next_actor: owner`. Cite only `driver.md:52` for that value. Optionally note that `common-rules.md:31` implies the owner is a stop case but does not specify next_actor.

### R2-F3 [minor]

The staging PostgREST-Aurora proxy workflow currently hardcodes the production Aurora secret `vitana/aurora/prod/postgrest-authenticator-uri` at lines 116 and 139, and injects it as the task definition's `PGRST_DB_URI`. The plan's section 3 correctly says the proxy will be 'repointed' and the staging-db-isolation lane has the workflow in its paths. But the `staging-prod-ref-guard` is described as checking 'a staging config' for production identifiers — it must also cover hardcoded secret names in workflow definitions and task definition templates, not just config files. The guard's test ('the guard fails on each production identifier in a fixture config') should include a fixture with a production secret name in a workflow/task-def context.

- `exafyltd/vitana-platform:.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml:116` — for NAME in vitana/aurora/prod/postgrest-authenticator-uri vitana/gateway/staging/supabase-jwt-secret; do
              ARN=$(aws secretsmanager describe-secret --secret-id "$NAME" --query ARN --output text 2>/dev/null || true)
              if [ -z "$ARN" ] || [ "$ARN" = "None" ]; then
                echo "::error::Secret '$NAME' missing in Secrets Manager. Refusing to register a task definition that cannot start."; exit 1
              fi
- `exafyltd/vitana-platform:.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml:139` — SEC_DB_URI=$(aws secretsmanager describe-secret --secret-id vitana/aurora/prod/postgrest-authenticator-uri --query ARN --output text)
            SEC_JWT=$(aws secretsmanager describe-secret --secret-id vitana/gateway/staging/supabase-jwt-secret --query ARN --output text)

Suggestion: Ensure the staging-prod-ref-guard's production identifier list includes `vitana/aurora/prod/postgrest-authenticator-uri` (and any other production-prefixed secret names used in staging workflows). The guard's test fixtures should include a workflow YAML with a production secret name, not only config files.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
