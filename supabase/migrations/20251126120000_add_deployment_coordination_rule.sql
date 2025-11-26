-- 20251126120000_add_deployment_coordination_rule.sql
-- VTID-0507 – Deployment Coordination Governance Rule
--
-- Purpose:
--   Adds the DC-001 rule to DEPLOYMENT_GOVERNANCE category.
--   This rule was created after a deployment incident where code was pushed
--   but not pulled before deployment, causing the old version to be deployed.
--
-- Rule: DC-001 - Deployment Coordination Protocol
--   - Claude must notify CEO before pushing
--   - Claude must provide explicit pull instructions after push
--   - Claude must verify deployment matches pushed code

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_category_id uuid;
BEGIN

  -- 1) Ensure DEPLOYMENT_GOVERNANCE category exists
  INSERT INTO governance_categories (tenant_id, name, description, severity)
  VALUES (
    v_tenant_id,
    'DEPLOYMENT_GOVERNANCE',
    'Rules governing deployment coordination, push-pull-deploy workflows, and environment synchronization.'
  , 3)
  ON CONFLICT (tenant_id, name) DO UPDATE
  SET description = EXCLUDED.description
  RETURNING id INTO v_category_id;

  -- Fallback if no update happened
  IF v_category_id IS NULL THEN
    SELECT id INTO v_category_id
    FROM governance_categories
    WHERE tenant_id = v_tenant_id AND name = 'DEPLOYMENT_GOVERNANCE';
  END IF;

  -- 2) Add DC-001 — Deployment Coordination Protocol
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'DC-001') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Deployment Coordination Protocol',
      'When Claude pushes code that requires deployment from a separate environment (e.g., CEO Cloud Shell), Claude MUST: (1) Notify before pushing, (2) Provide explicit git pull instructions after push, (3) Wait for pull confirmation before declaring ready, (4) Verify deployment matches pushed code.',
      TRUE,
      '{
        "rule_code": "DC-001",
        "type": "protocol",
        "incident_date": "2025-11-26",
        "incident_vtid": "VTID-0507",
        "mandatory_steps": [
          "Pre-push notification to CEO",
          "Explicit pull instructions after push",
          "Deployment readiness signal phrase",
          "Post-deployment visual verification"
        ],
        "forbidden_actions": [
          "Assume CEO environment has latest code",
          "Declare deployment complete without verification",
          "Skip pull reminder in instructions"
        ]
      }'::jsonb
    );
  END IF;

  -- 3) Add DC-002 — Environment Sync Verification
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'DC-002') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Environment Sync Verification',
      'Before deployment, Claude MUST verify that the target environment (Cloud Shell, CI runner, etc.) is synchronized with the source branch. This includes confirming git pull success and checking commit hash matches.',
      TRUE,
      '{
        "rule_code": "DC-002",
        "type": "verification",
        "verification_steps": [
          "Confirm git pull executed successfully",
          "Verify commit hash matches pushed commit",
          "Check npm run build completes without errors",
          "Validate dist folder contains expected changes"
        ]
      }'::jsonb
    );
  END IF;

  -- 4) Add DC-003 — Post-Deployment Validation
  IF NOT EXISTS (SELECT 1 FROM governance_rules WHERE tenant_id = v_tenant_id AND logic->>'rule_code' = 'DC-003') THEN
    INSERT INTO governance_rules (tenant_id, category_id, name, description, is_active, logic)
    VALUES (
      v_tenant_id,
      v_category_id,
      'Post-Deployment Validation',
      'After deployment, Claude MUST request verification from CEO (screenshot, URL test, or browser check). For UI changes, Claude must provide browser cache clearing guidance. VTID is not complete until visual/functional verification confirms changes are live.',
      TRUE,
      '{
        "rule_code": "DC-003",
        "type": "validation",
        "validation_methods": [
          "Screenshot verification request",
          "URL endpoint testing",
          "Browser hard refresh guidance (Ctrl+Shift+R)",
          "Incognito window testing"
        ]
      }'::jsonb
    );
  END IF;

END $$;
