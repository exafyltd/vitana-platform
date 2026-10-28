# VTID-04541 — Registry voice navigation switched on in production

Turns on the registry navigator (VTID-04517 resolver, VTID-04520 app
confirmation, VTID-04521 speak-then-navigate) on the production gateway. The
code has been on production since the 2026-09-25 09:08 UTC publish of
`ec9d5ee`, dormant because `NAV_V2_ENABLED` was unset there (read from the
live task def `vitana-gateway-awsdr:117`). The production frontend already
serves the registry at `https://vitanaland.com/nav-registry.json` (185
screens) and the app code that confirms navigations.

Change: `AWS-PROD-DEPLOY-GATEWAY.yml` strips and pins `NAV_V2_ENABLED=true`
and `NAV_REGISTRY_URL=https://vitanaland.com/nav-registry.json` (production's
own registry, never the staging one). Rollback: `NAV_V2_ENABLED` to `false`
and redeploy — every V2 branch falls back to the legacy navigator.

## Acceptance criteria

AC-1 The production workflow pins both flags, with production's own registry URL and never the staging one.
TEST: services/gateway/test/vtid-04517-staging-nav-v2-pinned.test.ts

AC-2 Every other pin on the production workflow is unchanged, its run steps stay valid bash and under GitHub's 20,000-character step limit.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
