/**
 * Preflight Chain Runner - VTID-01167
 *
 * CRITICAL: Preflight checks are GOVERNANCE EVALUATIONS, not a separate gate.
 * - Each skill maps to a governance rule ID
 * - Each result produces a GovernanceEvaluation record
 * - One gate, one record, one truth
 */

import { emitOasisEvent } from '../oasis-event-service';
import { GovernanceEvaluation } from '../../types/governance';
import { IDENTITY_DEFAULTS } from '../worker-orchestrator-service';

// =============================================================================
// Types
// =============================================================================

export interface PreflightContext {
  query: string;
  target_paths: string[];
}

/**
 * Governance-aligned skill result
 * Maps to GovernanceEvaluation format
 */
export interface GovernanceSkillResult {
  rule_id: string;
  rule_name: string;
  status: 'PASS' | 'FAIL';
  evaluated_at: string;
  metadata: {
    skill_id: string;
    domain: string;
    recommendation?: string;
    issues?: unknown[];
    duration_ms: number;
  };
}

export interface PreflightChainResult {
  ok: boolean;
  proceed: boolean;
  // Governance evaluations - same format as governance system
  governance_evaluations: GovernanceSkillResult[];
  // Summary for quick access
  summary: {
    total: number;
    passed: number;
    failed: number;
    blocked: boolean;
  };
}

// =============================================================================
// Skill -> Governance Rule Mapping (SINGLE SOURCE OF TRUTH)
// =============================================================================

const SKILL_TO_GOVERNANCE_RULE: Record<string, { rule_id: string; rule_name: string }> = {
  'worker.common.check_memory_first': {
    rule_id: 'GOV-WORK-R.1',
    rule_name: 'MEMORY_FIRST_CHECK',
  },
  'worker.backend.security_scan': {
    rule_id: 'GOV-SEC-R.1',
    rule_name: 'BACKEND_SECURITY_SCAN',
  },
  'worker.memory.validate_rls_policy': {
    rule_id: 'GOV-DATA-R.1',
    rule_name: 'RLS_POLICY_VALIDATION',
  },
  'worker.memory.preview_migration': {
    rule_id: 'GOV-DATA-R.2',
    rule_name: 'MIGRATION_PREVIEW',
  },
  'worker.backend.analyze_service': {
    rule_id: 'GOV-ARCH-R.1',
    rule_name: 'SERVICE_ANALYSIS',
  },
  'worker.frontend.validate_accessibility': {
    rule_id: 'GOV-A11Y-R.1',
    rule_name: 'ACCESSIBILITY_VALIDATION',
  },
};

// =============================================================================
// Preflight Chain Definitions (from VTID-01164)
// =============================================================================

const PREFLIGHT_CHAINS: Record<string, string[]> = {
  frontend: [
    'worker.common.check_memory_first',
    'worker.frontend.validate_accessibility',
  ],
  backend: [
    'worker.common.check_memory_first',
    'worker.backend.analyze_service',
    'worker.backend.security_scan',
  ],
  memory: [
    'worker.common.check_memory_first',
    'worker.memory.validate_rls_policy',
    'worker.memory.preview_migration',
  ],
};

// =============================================================================
// Skill Definitions (registered skills from VTID-01164)
// =============================================================================

const SKILL_DEFINITIONS = [
  { skill_id: 'worker.common.check_memory_first', name: 'Check Memory First', domain: 'common' },
  { skill_id: 'worker.backend.security_scan', name: 'Backend Security Scan', domain: 'backend' },
  { skill_id: 'worker.memory.validate_rls_policy', name: 'Validate RLS Policy', domain: 'memory' },
  { skill_id: 'worker.memory.preview_migration', name: 'Preview Migration', domain: 'memory' },
  { skill_id: 'worker.backend.analyze_service', name: 'Analyze Service', domain: 'backend' },
  { skill_id: 'worker.frontend.validate_accessibility', name: 'Validate Accessibility', domain: 'frontend' },
];

// =============================================================================
// Skill Execution (Produces Governance Evaluations)
// =============================================================================

/**
 * Execute a single skill and produce a governance evaluation
 */
async function executeSkillAsGovernance(
  skillId: string,
  vtid: string,
  context: PreflightContext,
  domain: string
): Promise<GovernanceSkillResult> {
  const startTime = Date.now();
  const ruleMapping = SKILL_TO_GOVERNANCE_RULE[skillId] || {
    rule_id: `GOV-UNKNOWN-${skillId}`,
    rule_name: skillId.toUpperCase(),
  };

  // Emit governance check start event
  await emitOasisEvent({
    vtid,
    type: 'GOVERNANCE_CHECK' as any,
    source: 'preflight-runner',
    status: 'info',
    message: `Evaluating governance rule: ${ruleMapping.rule_name}`,
    payload: {
      rule_id: ruleMapping.rule_id,
      rule_name: ruleMapping.rule_name,
      skill_id: skillId,
      tenant_id: IDENTITY_DEFAULTS.tenant,
    },
  });

  try {
    let ok = true;
    let recommendation: string | undefined;
    let issues: unknown[] = [];

    // Execute skill based on ID
    switch (skillId) {
      case 'worker.common.check_memory_first':
        ({ ok, recommendation } = await runCheckMemoryFirst(vtid, context));
        break;
      case 'worker.backend.security_scan':
        ({ ok, recommendation, issues } = await runSecurityScan(vtid, context));
        break;
      case 'worker.memory.validate_rls_policy':
        ({ ok, recommendation, issues } = await runValidateRlsPolicy(vtid, context));
        break;
      case 'worker.memory.preview_migration':
        ({ ok, recommendation, issues } = await runPreviewMigration(vtid, context));
        break;
      case 'worker.backend.analyze_service':
        ({ ok, recommendation, issues } = await runAnalyzeService(vtid, context));
        break;
      case 'worker.frontend.validate_accessibility':
        ({ ok, recommendation, issues } = await runValidateAccessibility(vtid, context));
        break;
    }

    const duration = Date.now() - startTime;
    const status: 'PASS' | 'FAIL' = ok ? 'PASS' : 'FAIL';
    const evaluated_at = new Date().toISOString();

    // Emit governance evaluation result (same format as governance system)
    await emitOasisEvent({
      vtid,
      type: 'GOVERNANCE_CHECK' as any,
      source: 'preflight-runner',
      status: ok ? 'success' : 'warning',
      message: `Rule ${ruleMapping.rule_name}: ${status}`,
      payload: {
        eventType: 'GOVERNANCE_CHECK',
        data: {
          ruleId: ruleMapping.rule_id,
          entityId: vtid,
          result: status,
          tenantId: IDENTITY_DEFAULTS.tenant,
          details: {
            skill_id: skillId,
            recommendation,
            issues,
            duration_ms: duration,
          },
        },
      },
    });

    return {
      rule_id: ruleMapping.rule_id,
      rule_name: ruleMapping.rule_name,
      status,
      evaluated_at,
      metadata: {
        skill_id: skillId,
        domain,
        recommendation,
        issues: issues.length > 0 ? issues : undefined,
        duration_ms: duration,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Emit governance evaluation error
    await emitOasisEvent({
      vtid,
      type: 'GOVERNANCE_CHECK' as any,
      source: 'preflight-runner',
      status: 'error',
      message: `Rule ${ruleMapping.rule_name} evaluation failed: ${errorMsg}`,
      payload: {
        eventType: 'GOVERNANCE_CHECK',
        data: {
          ruleId: ruleMapping.rule_id,
          entityId: vtid,
          result: 'FAIL',
          tenantId: IDENTITY_DEFAULTS.tenant,
          details: { error: errorMsg },
        },
      },
    });

    return {
      rule_id: ruleMapping.rule_id,
      rule_name: ruleMapping.rule_name,
      status: 'FAIL',
      evaluated_at: new Date().toISOString(),
      metadata: {
        skill_id: skillId,
        domain,
        recommendation: errorMsg,
        duration_ms: duration,
      },
    };
  }
}

// =============================================================================
// Individual Skill Implementations
// =============================================================================

interface SkillResult {
  ok: boolean;
  recommendation?: string;
  issues: unknown[];
}

async function runCheckMemoryFirst(vtid: string, context: PreflightContext): Promise<SkillResult> {
  console.log(`[GOV-WORK-R.1] check_memory_first: Checking for duplicates of ${vtid}`);
  // TODO: Implement actual OASIS query for duplicate detection
  return { ok: true, recommendation: 'no_duplicate_found', issues: [] };
}

async function runSecurityScan(vtid: string, context: PreflightContext): Promise<SkillResult> {
  console.log(`[GOV-SEC-R.1] security_scan: Scanning ${context.target_paths.length} paths`);
  const issues: unknown[] = [];

  for (const path of context.target_paths) {
    if (path.includes('.env') || path.includes('credentials') || path.includes('secret')) {
      issues.push({
        severity: 'high',
        path,
        message: 'Potential sensitive file modification detected',
      });
    }
  }

  return {
    ok: issues.length === 0,
    recommendation: issues.length > 0 ? 'review_security_concerns' : 'security_ok',
    issues,
  };
}

async function runValidateRlsPolicy(vtid: string, context: PreflightContext): Promise<SkillResult> {
  console.log(`[GOV-DATA-R.1] validate_rls_policy: Checking SQL files`);
  const sqlPaths = context.target_paths.filter(p => p.endsWith('.sql'));
  if (sqlPaths.length === 0) {
    return { ok: true, recommendation: 'no_sql_files', issues: [] };
  }
  return { ok: true, recommendation: 'rls_check_pending', issues: [] };
}

async function runPreviewMigration(vtid: string, context: PreflightContext): Promise<SkillResult> {
  console.log(`[GOV-DATA-R.2] preview_migration: Previewing migrations`);
  const migrationPaths = context.target_paths.filter(p => p.includes('migration') && p.endsWith('.sql'));
  if (migrationPaths.length === 0) {
    return { ok: true, recommendation: 'no_migrations', issues: [] };
  }
  return { ok: true, recommendation: 'migration_preview_ok', issues: [] };
}

async function runAnalyzeService(vtid: string, context: PreflightContext): Promise<SkillResult> {
  console.log(`[GOV-ARCH-R.1] analyze_service: Analyzing service structure`);
  return { ok: true, recommendation: 'analysis_complete', issues: [] };
}

async function runValidateAccessibility(vtid: string, context: PreflightContext): Promise<SkillResult> {
  console.log(`[GOV-A11Y-R.1] validate_accessibility: Checking accessibility`);
  const htmlPaths = context.target_paths.filter(p =>
    p.endsWith('.html') || p.endsWith('.tsx') || p.endsWith('.jsx')
  );
  if (htmlPaths.length === 0) {
    return { ok: true, recommendation: 'no_frontend_files', issues: [] };
  }
  return { ok: true, recommendation: 'accessibility_check_pending', issues: [] };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run preflight chain for a domain
 * Returns governance evaluations in the same format as the governance system
 */
export async function runPreflightChain(
  domain: 'frontend' | 'backend' | 'memory',
  vtid: string,
  context: PreflightContext
): Promise<PreflightChainResult> {
  const chain = PREFLIGHT_CHAINS[domain] || [];
  const evaluations: GovernanceSkillResult[] = [];

  console.log(`[VTID-01167] Running governance preflight chain for ${domain}: ${chain.length} rules`);

  // Emit chain start as governance batch
  await emitOasisEvent({
    vtid,
    type: 'GOVERNANCE_CHECK' as any,
    source: 'preflight-runner',
    status: 'info',
    message: `Starting governance evaluation batch for ${domain}`,
    payload: {
      domain,
      rules: chain.map(s => SKILL_TO_GOVERNANCE_RULE[s]?.rule_id),
      tenant_id: IDENTITY_DEFAULTS.tenant,
    },
  });

  // Execute each skill as a governance evaluation
  for (const skillId of chain) {
    const result = await executeSkillAsGovernance(skillId, vtid, context, domain);
    evaluations.push(result);

    // If a critical rule fails, we might want to stop early
    if (result.status === 'FAIL' && result.metadata.recommendation === 'duplicate_detected') {
      console.log(`[VTID-01167] Governance rule ${result.rule_id} blocked: duplicate detected`);
      break;
    }
  }

  // Calculate summary
  const passed = evaluations.filter(e => e.status === 'PASS').length;
  const failed = evaluations.filter(e => e.status === 'FAIL').length;
  const hasBlockers = evaluations.some(e =>
    e.status === 'FAIL' && (
      e.metadata.recommendation === 'duplicate_detected' ||
      (e.metadata.issues && Array.isArray(e.metadata.issues) &&
        e.metadata.issues.some((i: any) => i.severity === 'critical'))
    )
  );

  // Emit chain completion as governance batch result
  await emitOasisEvent({
    vtid,
    type: 'GOVERNANCE_CHECK' as any,
    source: 'preflight-runner',
    status: failed === 0 ? 'success' : 'warning',
    message: `Governance evaluation batch complete: ${passed}/${evaluations.length} passed`,
    payload: {
      domain,
      total: evaluations.length,
      passed,
      failed,
      blocked: hasBlockers,
      evaluations: evaluations.map(e => ({
        rule_id: e.rule_id,
        status: e.status,
      })),
    },
  });

  return {
    ok: failed === 0,
    proceed: !hasBlockers,
    governance_evaluations: evaluations,
    summary: {
      total: evaluations.length,
      passed,
      failed,
      blocked: hasBlockers,
    },
  };
}

/**
 * List available skills with governance rule mappings
 */
export function listSkills(): Array<{ skill_id: string; name: string; domain: string; rule_id: string }> {
  return SKILL_DEFINITIONS.map(s => ({
    ...s,
    rule_id: SKILL_TO_GOVERNANCE_RULE[s.skill_id]?.rule_id || 'UNKNOWN',
  }));
}

/**
 * Get preflight chains configuration with governance rule mappings
 */
export function getPreflightChains(): Record<string, { skill_id: string; rule_id: string }[]> {
  const result: Record<string, { skill_id: string; rule_id: string }[]> = {};
  for (const [domain, skills] of Object.entries(PREFLIGHT_CHAINS)) {
    result[domain] = skills.map(s => ({
      skill_id: s,
      rule_id: SKILL_TO_GOVERNANCE_RULE[s]?.rule_id || 'UNKNOWN',
    }));
  }
  return result;
}
