# VTID-05518 acceptance (eng-platform-p01/stage-oidc-platform)
Change types: Infrastructure/CI.
AC-1 Every vitana-platform workflow that names the staging keys (found by grep) uses role-to-assume: vars.<ROLE> and keeps the keys only behind !vars.<ROLE>; ALERT-APP-USERS-IDENTITY-DRIFT uses AWS_DRIFT_ROLE_ARN (sparring R1-F3), the others AWS_STAGING_ROLE_ARN.
TEST: jest eng-platform-stage-oidc-workflows ("every credential step ...", "no unguarded static key remains").
AC-2 Each file grants id-token: write at the top level; the APPILIX prod leg stays on AWS_PROD_ROLE_ARN; no AWS-PROD-* file changes.
TEST: jest ("grants id-token: write ...", "keeps its production leg ...", "covers the eight known ...").
AC-3 MIGRATION-DRIFT-CHECK assumes vars.AWS_DRIFT_ROLE_ARN || secrets.AWS_PROD_ROLE_ARN and, with the drift role, reads through claude-readonly, never the master secret.
TEST: jest ("MIGRATION-DRIFT-CHECK reads Aurora with the read-only role ...").
AC-4 vtid-05009: only the :24 id-token assertion is replaced by "the only role-to-assume is vars.AWS_STAGING_ROLE_ARN" (plan §4, sparring R1-F1 of 8cc4dc48); its other assertions unchanged.
TEST: jest vtid-05009-provision-pack-token-workflow.
Staging proof: not verified on staging (OIDC path): role not created yet (owner step). The merge redeploys gateway/kiro-runner/erp-bridge/postgrest-proxy staging on the unchanged key path; each deploy's smoke gate covers it.
