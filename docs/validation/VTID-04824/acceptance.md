# VTID-04824 — production gateway deploy: Jev secret and gate switches in their own step

`AWS-PROD-DEPLOY-GATEWAY.yml` step "Build task-definition (2/2)" reached 19,964 of GitHub's 20,000-char per-step run
limit with E2's pin (VTID-04822); the next Jev gate could not be pinned. The Jev block (TypeSafe secret reference,
`JEV_DECISIONS_ENABLED`, every `JEV_*_MODE` switch) moves verbatim into its own step.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New step "Build task-definition (Jev gates)" runs in every deploy mode between step 1/2 and step 2/2: it reads `/tmp/vitana-new-task-def.json`, applies the unchanged Jev block (TYPESAFE_API_KEY as a secret reference, never a plain value; strip-then-add of JEV_DECISIONS_ENABLED and every JEV_*_MODE) and writes the file back; step 2/2 no longer carries it and its `env_overrides` still apply last.
  TEST: services/gateway/test/vtid-04754-jev-prod-workflow.test.ts
AC-2: Every step stays under 20,000 chars (step 1/2 19,951; Jev step 2,821; step 2/2 17,531); every gate's own pin test and the generated pins are unchanged.
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
  TEST: services/gateway/test/vtid-04822-document-type-routing.test.ts

## Scope

SCOPE_ALLOWLIST:
- .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (one block moved into a new step; one comment)
- services/gateway/test/vtid-04754-jev-prod-workflow.test.ts (reads the new step; the contract — Jev before env_overrides, secret reference only — is the same)
- docs/validation/VTID-04824/**

## OASIS

OASIS_IMPACT: none.

## MERGE_PAYLOAD_PREVIEW

Workflow-only. The next production deploy builds the same task definition as before (same Jev secret and switches);
it only sets them one step earlier. No runtime change.
