-- 20251120192139_oasis_gov_0108_rules_seed.sql
-- DEV-OASIS-GOV-0108 — Seed Vitana Governance Rules Library
-- 
-- Purpose: Insert comprehensive governance rules across all categories
-- Dependencies: Migrations 0101 (schema), 0102 (categories), 0103 (MG rules)
-- Follows: MG-001 (Idempotent SQL Requirement)

-- NOTE: This migration assumes a unique constraint or index on rule_code exists.
-- If not, the ON CONFLICT will need adjustment to use (tenant_id, rule_code) or similar.

-- ============================================================================
-- VALIDATE REQUIRED CATEGORIES EXIST
-- ============================================================================

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_missing_categories text[] := ARRAY[]::text[];
  v_cat text;
BEGIN
  FOR v_cat IN 
    SELECT unnest(ARRAY[
      'DEPLOYMENT_GOVERNANCE',
      'CSP_GOVERNANCE',
      'NAVIGATION_GOVERNANCE',
      'UI_GOVERNANCE',
      'MEMORY_GOVERNANCE',
      'RULE_ENGINE_GOVERNANCE',
      'VALIDATOR_GOVERNANCE',
      'API_GOVERNANCE',
      'SECURITY_GOVERNANCE'
    ])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM governance_categories 
      WHERE tenant_id = v_tenant_id AND name = v_cat
    ) THEN
      v_missing_categories := array_append(v_missing_categories, v_cat);
    END IF;
  END LOOP;

  IF array_length(v_missing_categories, 1) > 0 THEN
    RAISE EXCEPTION 'Missing required categories: %. Run migration 0102 first.', 
      array_to_string(v_missing_categories, ', ');
  END IF;

  RAISE NOTICE 'All required governance categories validated';
END $$;

-- ============================================================================
-- ADD UNIQUE CONSTRAINT ON RULE_CODE (IF NOT EXISTS)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'governance_rules_rule_code_key'
  ) THEN
    ALTER TABLE governance_rules 
      ADD CONSTRAINT governance_rules_rule_code_key 
      UNIQUE (rule_code);
    RAISE NOTICE 'Added unique constraint on rule_code';
  ELSE
    RAISE NOTICE 'Unique constraint on rule_code already exists';
  END IF;
END $$;

-- ============================================================================
-- INSERT GOVERNANCE RULES LIBRARY
-- ============================================================================

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_cat_deployment uuid;
  v_cat_csp uuid;
  v_cat_navigation uuid;
  v_cat_ui uuid;
  v_cat_memory uuid;
  v_cat_rule_engine uuid;
  v_cat_validator uuid;
  v_cat_api uuid;
  v_cat_security uuid;
BEGIN
  -- Get category IDs
  SELECT id INTO v_cat_deployment FROM governance_categories WHERE tenant_id = v_tenant_id AND name = 'DEPLOYMENT_GOVERNANCE';
  SELECT id INTO v_cat_csp FROM governance_categories WHERE tenant_id = v_tenant_id AND name = 'CSP_GOVERNANCE';
  SELECT id INTO v_cat_navigation FROM governance_categories WHERE tenant_id = v_tenant_id AND name = 'NAVIGATION_GOVERNANCE';
  SELECT id INTO v_cat_ui FROM governance_categories WHERE tenant_id = v_tenant_id AND name = 'UI_GOVERNANCE';
  SELECT id INTO v_cat_memory FROM governance_categories WHERE tenant_id = v_tenant_id AND name = 'MEMORY_GOVERNANCE';
  SELECT id INTO v_cat_rule_engine FROM governance_categories WHERE tenant_id = v_tenant_id AND name = 'RULE_ENGINE_GOVERNANCE';
  SELECT id INTO v_cat_validator FROM governance_categories WHERE tenant_id = v_tenant_id AND name = 'VALIDATOR_GOVERNANCE';
  SELECT id INTO v_cat_api FROM governance_categories WHERE tenant_id = v_tenant_id AND name = 'API_GOVERNANCE';
  SELECT id INTO v_cat_security FROM governance_categories WHERE tenant_id = v_tenant_id AND name = 'SECURITY_GOVERNANCE';

  -- ========================================================================
  -- DEPLOYMENT_GOVERNANCE RULES
  -- ========================================================================

  -- DEP-001 — Canonical Deployment Script Only
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_deployment,
    'Canonical Deployment Script Only',
    'All gateway deployments MUST use ./scripts/deploy/deploy-service.sh gateway services/gateway. No custom deploy commands allowed.',
    jsonb_build_object(
      'rule_code', 'DEP-001',
      'name', 'Canonical Deployment Script Only',
      'description', 'Enforce SYS-RULE-DEPLOY-L1: All gateway deployments MUST use the canonical deployment script',
      'category_key', 'DEPLOYMENT_GOVERNANCE',
      'governance_area', 'deployment',
      'enforcement', 'mandatory',
      'severity', 3,
      'examples', ARRAY['./scripts/deploy/deploy-service.sh gateway services/gateway'],
      'prohibited', ARRAY['gcloud run deploy', 'custom deploy scripts'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- DEP-002 — Canonical Gateway Service Name
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_deployment,
    'Canonical Gateway Service Name',
    'All production & dev automation must deploy to service name "gateway" only.',
    jsonb_build_object(
      'rule_code', 'DEP-002',
      'name', 'Canonical Gateway Service Name',
      'description', 'Service name must be "gateway" - no variations like vitana-dev-gateway or vitana-gateway',
      'category_key', 'DEPLOYMENT_GOVERNANCE',
      'governance_area', 'deployment',
      'enforcement', 'mandatory',
      'severity', 3,
      'allowed_names', ARRAY['gateway'],
      'prohibited_names', ARRAY['vitana-gateway', 'vitana-dev-gateway', 'gateway-dev'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- DEP-003 — Build Validation Before Deploy
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_deployment,
    'Build Validation Before Deploy',
    'npm run build (or equivalent) MUST succeed before deployment; deployment forbidden on failing build.',
    jsonb_build_object(
      'rule_code', 'DEP-003',
      'name', 'Build Validation Before Deploy',
      'description', 'Build must pass before deployment can proceed',
      'category_key', 'DEPLOYMENT_GOVERNANCE',
      'governance_area', 'deployment',
      'enforcement', 'mandatory',
      'severity', 3,
      'build_commands', ARRAY['npm run build', 'pnpm build', 'yarn build'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- DEP-004 — Post-Deploy Verification
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_deployment,
    'Post-Deploy Verification',
    'After deployment, verify: latestReadyRevisionName changed, API responds 200, CSP/Golden Board rules not violated.',
    jsonb_build_object(
      'rule_code', 'DEP-004',
      'name', 'Post-Deploy Verification',
      'description', 'Deployment must be verified before marked successful',
      'category_key', 'DEPLOYMENT_GOVERNANCE',
      'governance_area', 'deployment',
      'enforcement', 'mandatory',
      'severity', 2,
      'verification_checks', ARRAY[
        'latestReadyRevisionName changed',
        '/api/v1/oasis/tasks?limit=1 responds 200',
        'CSP rules not violated',
        'Golden Board rules not violated'
      ],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- ========================================================================
  -- CSP_GOVERNANCE RULES
  -- ========================================================================

  -- CSP-001 — No Inline Scripts
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_csp,
    'No Inline Scripts',
    'Disallow any <script> tag without src attribute. All JavaScript must be in external files.',
    jsonb_build_object(
      'rule_code', 'CSP-001',
      'name', 'No Inline Scripts',
      'description', 'Content Security Policy forbids inline scripts',
      'category_key', 'CSP_GOVERNANCE',
      'governance_area', 'security',
      'enforcement', 'mandatory',
      'severity', 3,
      'prohibited_patterns', ARRAY['<script>', '<script type="text/javascript">'],
      'required_pattern', '<script src="..."',
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- CSP-002 — No External CDNs
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_csp,
    'No External CDNs',
    'Disallow React/JS frameworks via CDN; must be bundled locally.',
    jsonb_build_object(
      'rule_code', 'CSP-002',
      'name', 'No External CDNs',
      'description', 'All JavaScript dependencies must be bundled locally, no CDN imports',
      'category_key', 'CSP_GOVERNANCE',
      'governance_area', 'security',
      'enforcement', 'mandatory',
      'severity', 3,
      'prohibited_domains', ARRAY['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- CSP-003 — CSP Violations = Hard Block
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_csp,
    'CSP Violations = Hard Block',
    'Any CSP violation in build output MUST fail Validator and block deployment.',
    jsonb_build_object(
      'rule_code', 'CSP-003',
      'name', 'CSP Violations = Hard Block',
      'description', 'CSP violations must prevent deployment',
      'category_key', 'CSP_GOVERNANCE',
      'governance_area', 'security',
      'enforcement', 'mandatory',
      'severity', 3,
      'action', 'block_deployment',
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- ========================================================================
  -- NAVIGATION_GOVERNANCE RULES
  -- ========================================================================

  -- NAV-001 — Sidebar Canon Rule
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_navigation,
    'Sidebar Canon Rule',
    'Sidebar has fixed order: Home, Community, Discover, Inbox, Health, Wallet, Sharing, Memory, Settings, Start Stream, Profile Capsule. No modifications allowed.',
    jsonb_build_object(
      'rule_code', 'NAV-001',
      'name', 'Sidebar Canon Rule',
      'description', 'Main sidebar structure and order is immutable',
      'category_key', 'NAVIGATION_GOVERNANCE',
      'governance_area', 'ui',
      'enforcement', 'mandatory',
      'severity', 2,
      'canonical_order', ARRAY[
        'Home', 'Community', 'Discover', 'Inbox', 'Health', 
        'Wallet', 'Sharing', 'Memory', 'Settings', 'Start Stream', 'Profile Capsule'
      ],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- NAV-002 — Dev/Admin Sidebar Canon
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_navigation,
    'Dev/Admin Sidebar Canon',
    'Vitana Dev and Vitana Admin sidebars must preserve their defined module lists per blueprint; no unauthorized changes.',
    jsonb_build_object(
      'rule_code', 'NAV-002',
      'name', 'Dev/Admin Sidebar Canon',
      'description', 'Admin and Dev console sidebars follow blueprint definitions',
      'category_key', 'NAVIGATION_GOVERNANCE',
      'governance_area', 'ui',
      'enforcement', 'mandatory',
      'severity', 2,
      'affected_interfaces', ARRAY['Vitana Dev', 'Vitana Admin'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- NAV-003 — Start Stream Placement
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_navigation,
    'Start Stream Placement',
    'Start Stream lives ONLY in the sidebar utility zone and is NOT a broadcast/live-room control.',
    jsonb_build_object(
      'rule_code', 'NAV-003',
      'name', 'Start Stream Placement',
      'description', 'Start Stream location is fixed to sidebar utility zone',
      'category_key', 'NAVIGATION_GOVERNANCE',
      'governance_area', 'ui',
      'enforcement', 'mandatory',
      'severity', 2,
      'allowed_location', 'sidebar utility zone',
      'prohibited_locations', ARRAY['broadcast controls', 'live room', 'top bar'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- ========================================================================
  -- UI_GOVERNANCE RULES
  -- ========================================================================

  -- UI-001 — Golden Command Hub Task Board
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_ui,
    'Golden Command Hub Task Board',
    'Preserve .task-board, .task-column, .task-card selectors and 3-column layout (Scheduled, In Progress, Completed).',
    jsonb_build_object(
      'rule_code', 'UI-001',
      'name', 'Golden Command Hub Task Board',
      'description', 'Command Hub Task Board structure is protected',
      'category_key', 'UI_GOVERNANCE',
      'governance_area', 'ui',
      'enforcement', 'mandatory',
      'severity', 2,
      'protected_selectors', ARRAY['.task-board', '.task-column', '.task-card'],
      'protected_layout', '3-column',
      'required_columns', ARRAY['Scheduled', 'In Progress', 'Completed'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- UI-002 — Fixed Layout Regions
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_ui,
    'Fixed Layout Regions',
    'Global sidebar, top bar, and main content frame are immutable; only the inner content area may change.',
    jsonb_build_object(
      'rule_code', 'UI-002',
      'name', 'Fixed Layout Regions',
      'description', 'Core layout structure is protected from modification',
      'category_key', 'UI_GOVERNANCE',
      'governance_area', 'ui',
      'enforcement', 'mandatory',
      'severity', 2,
      'immutable_regions', ARRAY['global sidebar', 'top bar', 'main content frame'],
      'mutable_region', 'inner content area',
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- ========================================================================
  -- MEMORY_GOVERNANCE RULES
  -- ========================================================================

  -- MEM-001 — Memory-First Execution
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_memory,
    'Memory-First Execution',
    'Agents must check governance, OASIS, and task history before asking user for configuration or URLs.',
    jsonb_build_object(
      'rule_code', 'MEM-001',
      'name', 'Memory-First Execution',
      'description', 'Check existing knowledge before querying user',
      'category_key', 'MEMORY_GOVERNANCE',
      'governance_area', 'agent_behavior',
      'enforcement', 'recommended',
      'severity', 1,
      'check_sources', ARRAY['governance_rules', 'oasis_events', 'task_history'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- MEM-002 — No Duplicate Questions
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_memory,
    'No Duplicate Questions',
    'Agents must avoid asking for data already present in OASIS or governance.',
    jsonb_build_object(
      'rule_code', 'MEM-002',
      'name', 'No Duplicate Questions',
      'description', 'Do not re-query information already available in system',
      'category_key', 'MEMORY_GOVERNANCE',
      'governance_area', 'agent_behavior',
      'enforcement', 'recommended',
      'severity', 1,
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- ========================================================================
  -- RULE_ENGINE_GOVERNANCE RULES
  -- ========================================================================

  -- RUL-001 — Deterministic Evaluation
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_rule_engine,
    'Deterministic Evaluation',
    'Rule engine must be deterministic; same input → same output.',
    jsonb_build_object(
      'rule_code', 'RUL-001',
      'name', 'Deterministic Evaluation',
      'description', 'Rule evaluation must produce consistent results',
      'category_key', 'RULE_ENGINE_GOVERNANCE',
      'governance_area', 'rule_engine',
      'enforcement', 'mandatory',
      'severity', 3,
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- RUL-002 — Pre-Execution Check
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_rule_engine,
    'Pre-Execution Check',
    'All critical actions (deployments, schema changes, CSP changes, navigation changes) MUST pass rule-engine checks before execution.',
    jsonb_build_object(
      'rule_code', 'RUL-002',
      'name', 'Pre-Execution Check',
      'description', 'Critical actions require governance approval before execution',
      'category_key', 'RULE_ENGINE_GOVERNANCE',
      'governance_area', 'rule_engine',
      'enforcement', 'mandatory',
      'severity', 3,
      'critical_actions', ARRAY['deployments', 'schema_changes', 'csp_changes', 'navigation_changes'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- ========================================================================
  -- VALIDATOR_GOVERNANCE RULES
  -- ========================================================================

  -- VAL-001 — Validator Non-Creative
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_validator,
    'Validator Non-Creative',
    'Validator is forbidden from generating new code or architecture; it only approves or rejects.',
    jsonb_build_object(
      'rule_code', 'VAL-001',
      'name', 'Validator Non-Creative',
      'description', 'Validator role is verify-only, not generate',
      'category_key', 'VALIDATOR_GOVERNANCE',
      'governance_area', 'validator',
      'enforcement', 'mandatory',
      'severity', 3,
      'allowed_actions', ARRAY['approve', 'reject', 'verify'],
      'prohibited_actions', ARRAY['generate_code', 'create_architecture', 'modify_design'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- VAL-002 — Governance-Backed Decisions
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_validator,
    'Governance-Backed Decisions',
    'Validator decisions MUST cite the relevant rules from governance_rules.',
    jsonb_build_object(
      'rule_code', 'VAL-002',
      'name', 'Governance-Backed Decisions',
      'description', 'All validator decisions must reference specific governance rules',
      'category_key', 'VALIDATOR_GOVERNANCE',
      'governance_area', 'validator',
      'enforcement', 'mandatory',
      'severity', 2,
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- VAL-003 — Hard Stop on Uncertainty
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_validator,
    'Hard Stop on Uncertainty',
    'Any uncertainty or missing rule → Validator MUST block the action.',
    jsonb_build_object(
      'rule_code', 'VAL-003',
      'name', 'Hard Stop on Uncertainty',
      'description', 'Validator blocks actions when governance is unclear or incomplete',
      'category_key', 'VALIDATOR_GOVERNANCE',
      'governance_area', 'validator',
      'enforcement', 'mandatory',
      'severity', 3,
      'action', 'block',
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- ========================================================================
  -- API_GOVERNANCE RULES
  -- ========================================================================

  -- API-001 — Gateway Route Mount Rule
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_api,
    'Gateway Route Mount Rule',
    'Agents must inspect Express app mounts (app.use) and compute final paths correctly. Incorrect mount → governance violation.',
    jsonb_build_object(
      'rule_code', 'API-001',
      'name', 'Gateway Route Mount Rule',
      'description', 'API route paths must be computed correctly from Express mounts',
      'category_key', 'API_GOVERNANCE',
      'governance_area', 'api',
      'enforcement', 'mandatory',
      'severity', 2,
      'examples', ARRAY['app.use(''/api/v1'', router)'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- API-002 — OASIS Ingestion Integrity
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_api,
    'OASIS Ingestion Integrity',
    'All new APIs impacting tasks/events MUST write to OASIS via the ingestion API.',
    jsonb_build_object(
      'rule_code', 'API-002',
      'name', 'OASIS Ingestion Integrity',
      'description', 'Task and event APIs must log to OASIS event system',
      'category_key', 'API_GOVERNANCE',
      'governance_area', 'api',
      'enforcement', 'mandatory',
      'severity', 2,
      'ingestion_endpoint', '/api/v1/events/ingest',
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- ========================================================================
  -- SECURITY_GOVERNANCE RULES
  -- ========================================================================

  -- SEC-001 — No Hardcoded Secrets
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_security,
    'No Hardcoded Secrets',
    'All secrets must come from environment or secret manager, never hardcoded.',
    jsonb_build_object(
      'rule_code', 'SEC-001',
      'name', 'No Hardcoded Secrets',
      'description', 'Credentials and API keys must use environment variables or secret manager',
      'category_key', 'SECURITY_GOVERNANCE',
      'governance_area', 'security',
      'enforcement', 'mandatory',
      'severity', 3,
      'allowed_sources', ARRAY['process.env', 'Secret Manager', 'GitHub Secrets'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  -- ========================================================================
  -- SELF-GOVERNANCE / PENALTY RULES
  -- ========================================================================

  -- GOV-SELF-001 — Penalty for Core Violations
  INSERT INTO governance_rules (tenant_id, category_id, name, description, logic, is_active)
  VALUES (
    v_tenant_id, v_cat_security,  -- Using SECURITY_GOVERNANCE for penalty rules
    'Governance Violation Penalty',
    'If Gateway URL, CSP, Golden Board, or Sidebar Canon rules are violated: log violation, trigger escalation event, block future deployments.',
    jsonb_build_object(
      'rule_code', 'GOV-SELF-001',
      'name', 'Governance Violation Penalty',
      'description', 'GOV-AICOR-PENALTY-SELF-0001 - System response to core governance violations',
      'category_key', 'SECURITY_GOVERNANCE',
      'governance_area', 'governance_enforcement',
      'enforcement', 'mandatory',
      'severity', 3,
      'trigger_rules', ARRAY['Gateway URL hardcoding', 'CSP violations', 'Golden Board changes', 'Sidebar Canon violations'],
      'actions', ARRAY['log_violation', 'trigger_escalation', 'block_deployments'],
      'version', '1.0',
      'source', 'vitana-governance-v1'
    ),
    TRUE
  )
  ON CONFLICT (rule_code) DO UPDATE
    SET logic = EXCLUDED.logic, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

  RAISE NOTICE 'Vitana Governance Rules Library seeded successfully';
END $$;

-- ============================================================================
-- VERIFY ALL RULES INSERTED
-- ============================================================================

DO $$
DECLARE
  v_tenant_id text := 'SYSTEM';
  v_rule_counts jsonb;
  v_total_rules integer;
BEGIN
  -- Count rules by category
  SELECT jsonb_object_agg(
    gc.name,
    (SELECT COUNT(*) FROM governance_rules gr WHERE gr.category_id = gc.id AND gr.tenant_id = v_tenant_id)
  ) INTO v_rule_counts
  FROM governance_categories gc
  WHERE gc.tenant_id = v_tenant_id;

  -- Total count
  SELECT COUNT(*) INTO v_total_rules
  FROM governance_rules
  WHERE tenant_id = v_tenant_id;

  RAISE NOTICE '========================================';
  RAISE NOTICE 'GOVERNANCE RULES LIBRARY SEEDING COMPLETE';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Total rules: %', v_total_rules;
  RAISE NOTICE 'Rules by category: %', v_rule_counts;
  RAISE NOTICE '========================================';
END $$;

-- ============================================================================
-- VERIFY NO ORPHANED RULES
-- ============================================================================

DO $$
DECLARE
  v_orphaned_count integer;
BEGIN
  SELECT COUNT(*) INTO v_orphaned_count
  FROM governance_rules r
  WHERE r.category_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM governance_categories c WHERE c.id = r.category_id
    );

  IF v_orphaned_count > 0 THEN
    RAISE WARNING 'Found % orphaned rules without valid category', v_orphaned_count;
  ELSE
    RAISE NOTICE 'No orphaned rules found - all category references valid';
  END IF;
END $$;
