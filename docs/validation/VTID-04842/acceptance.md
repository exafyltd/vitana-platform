# VTID-04842 — Commerce AI setup switched on for staging

Owner request 2026-10-02: switch on "Set up with AI" (VTID-04838/04839) and
Vitana's voice setup (VTID-04840/04841) on staging so the owner can run the
end-to-end setup there. Production is unchanged.

VALIDATION_PROFILE: gateway_backend

OASIS_IMPACT: no — a task-definition environment value; the feature's own
`commerce.ai_setup.applied` event is emitted by VTID-04838's apply endpoint.

## Acceptance criteria

AC-1: The staging gateway task definition carries COMMERCE_AI_SETUP_ENABLED=true (stripped and re-added like every other managed flag, so a redeploy cannot duplicate it); AWS-PROD-DEPLOY-GATEWAY.yml does not set it.
  TEST: e2e/staging/vtid-04842-commerce-ai-setup-on.staging.spec.ts
AC-2: After the staging deploy, a signed-in GET /api/v1/commerce/ai-setup/status answers {"ok":true,"enabled":true}; unauthenticated it stays 401.
  TEST: e2e/staging/vtid-04842-commerce-ai-setup-on.staging.spec.ts

## Scope

- Changed: `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` (one env value).
- New: the read-only staging spec and this evidence pack.
