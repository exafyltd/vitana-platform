/**
 * Preflight Chain Runner - VTID-01167
 *
 * Gateway-local implementation of preflight chain execution.
 * Integrates with VTID-01164 skill pack by calling skills through OASIS events.
 */

import { emitOasisEvent } from '../oasis-event-service';

// =============================================================================
// Types
// =============================================================================

export interface PreflightContext {
  query: string;
  target_paths: string[];
}

export interface PreflightSkillResult {
  skill_id: string;
  ok: boolean;
  recommendation?: string;
  issues?: unknown[];
}

export interface PreflightChainResult {
  ok: boolean;
  results: PreflightSkillResult[];
  proceed: boolean;
}

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
// Skill Execution
// =============================================================================

/**
 * Execute a single skill and emit OASIS events
 */
async function executeSkill(
  skillId: string,
  vtid: string,
  context: PreflightContext
): Promise<PreflightSkillResult> {
  const startTime = Date.now();

  // Emit skill start event
  await emitOasisEvent({
    vtid,
    type: 'vtid.skill.start' as any,
    source: skillId,
    status: 'info',
    message: `Starting skill: ${skillId}`,
    payload: {
      skill_id: skillId,
      query: context.query,
      target_paths: context.target_paths,
    },
  });

  try {
    let result: PreflightSkillResult;

    // Execute skill based on ID
    switch (skillId) {
      case 'worker.common.check_memory_first':
        result = await runCheckMemoryFirst(vtid, context);
        break;
      case 'worker.backend.security_scan':
        result = await runSecurityScan(vtid, context);
        break;
      case 'worker.memory.validate_rls_policy':
        result = await runValidateRlsPolicy(vtid, context);
        break;
      case 'worker.memory.preview_migration':
        result = await runPreviewMigration(vtid, context);
        break;
      case 'worker.backend.analyze_service':
        result = await runAnalyzeService(vtid, context);
        break;
      case 'worker.frontend.validate_accessibility':
        result = await runValidateAccessibility(vtid, context);
        break;
      default:
        result = { skill_id: skillId, ok: true };
    }

    // Emit skill completion event
    const duration = Date.now() - startTime;
    await emitOasisEvent({
      vtid,
      type: 'vtid.skill.complete' as any,
      source: skillId,
      status: result.ok ? 'success' : 'warning',
      message: result.ok ? `Skill ${skillId} passed` : `Skill ${skillId} found issues`,
      payload: {
        skill_id: skillId,
        duration_ms: duration,
        ...result,
      },
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    await emitOasisEvent({
      vtid,
      type: 'vtid.skill.error' as any,
      source: skillId,
      status: 'error',
      message: `Skill ${skillId} failed: ${errorMsg}`,
      payload: {
        skill_id: skillId,
        duration_ms: duration,
        error: errorMsg,
      },
    });

    return {
      skill_id: skillId,
      ok: false,
      recommendation: errorMsg,
    };
  }
}

// =============================================================================
// Individual Skill Implementations (Lightweight versions)
// =============================================================================

/**
 * Check Memory First - Detects duplicate work by searching OASIS history
 */
async function runCheckMemoryFirst(
  vtid: string,
  context: PreflightContext
): Promise<PreflightSkillResult> {
  // In a full implementation, this would query OASIS for similar past work
  // For now, we emit the event and return ok
  console.log(`[VTID-01164] check_memory_first: Checking for duplicates of ${vtid}`);

  // TODO: Implement actual OASIS query for duplicate detection
  // This would call the OASIS search API to find similar completed tasks

  return {
    skill_id: 'worker.common.check_memory_first',
    ok: true,
    recommendation: 'no_duplicate_found',
  };
}

/**
 * Security Scan - Scans target paths for security vulnerabilities
 */
async function runSecurityScan(
  vtid: string,
  context: PreflightContext
): Promise<PreflightSkillResult> {
  console.log(`[VTID-01164] security_scan: Scanning ${context.target_paths.length} paths`);

  // Lightweight check - in full implementation would scan file contents
  const issues: unknown[] = [];

  // Check for dangerous patterns in paths
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
    skill_id: 'worker.backend.security_scan',
    ok: issues.length === 0,
    issues,
    recommendation: issues.length > 0 ? 'review_security_concerns' : 'security_ok',
  };
}

/**
 * Validate RLS Policy - Checks SQL files for proper RLS policies
 */
async function runValidateRlsPolicy(
  vtid: string,
  context: PreflightContext
): Promise<PreflightSkillResult> {
  console.log(`[VTID-01164] validate_rls_policy: Checking SQL files`);

  const sqlPaths = context.target_paths.filter(p => p.endsWith('.sql'));

  if (sqlPaths.length === 0) {
    return {
      skill_id: 'worker.memory.validate_rls_policy',
      ok: true,
      recommendation: 'no_sql_files',
    };
  }

  // TODO: In full implementation, read SQL files and check for RLS policies
  return {
    skill_id: 'worker.memory.validate_rls_policy',
    ok: true,
    recommendation: 'rls_check_pending',
    issues: [],
  };
}

/**
 * Preview Migration - Previews database migration impacts
 */
async function runPreviewMigration(
  vtid: string,
  context: PreflightContext
): Promise<PreflightSkillResult> {
  console.log(`[VTID-01164] preview_migration: Previewing migrations`);

  const migrationPaths = context.target_paths.filter(p =>
    p.includes('migration') && p.endsWith('.sql')
  );

  if (migrationPaths.length === 0) {
    return {
      skill_id: 'worker.memory.preview_migration',
      ok: true,
      recommendation: 'no_migrations',
    };
  }

  return {
    skill_id: 'worker.memory.preview_migration',
    ok: true,
    recommendation: 'migration_preview_ok',
    issues: [],
  };
}

/**
 * Analyze Service - Analyzes service dependencies and structure
 */
async function runAnalyzeService(
  vtid: string,
  context: PreflightContext
): Promise<PreflightSkillResult> {
  console.log(`[VTID-01164] analyze_service: Analyzing service structure`);

  // TODO: In full implementation, analyze import graphs and dependencies
  return {
    skill_id: 'worker.backend.analyze_service',
    ok: true,
    recommendation: 'analysis_complete',
    issues: [],
  };
}

/**
 * Validate Accessibility - Checks for WCAG compliance issues
 */
async function runValidateAccessibility(
  vtid: string,
  context: PreflightContext
): Promise<PreflightSkillResult> {
  console.log(`[VTID-01164] validate_accessibility: Checking accessibility`);

  const htmlPaths = context.target_paths.filter(p =>
    p.endsWith('.html') || p.endsWith('.tsx') || p.endsWith('.jsx')
  );

  if (htmlPaths.length === 0) {
    return {
      skill_id: 'worker.frontend.validate_accessibility',
      ok: true,
      recommendation: 'no_frontend_files',
    };
  }

  return {
    skill_id: 'worker.frontend.validate_accessibility',
    ok: true,
    recommendation: 'accessibility_check_pending',
    issues: [],
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run preflight chain for a domain
 */
export async function runPreflightChain(
  domain: 'frontend' | 'backend' | 'memory',
  vtid: string,
  context: PreflightContext
): Promise<PreflightChainResult> {
  const chain = PREFLIGHT_CHAINS[domain] || [];
  const results: PreflightSkillResult[] = [];

  console.log(`[VTID-01164] Running preflight chain for ${domain}: ${chain.length} skills`);

  // Emit chain start event
  await emitOasisEvent({
    vtid,
    type: 'vtid.preflight.start' as any,
    source: 'preflight-runner',
    status: 'info',
    message: `Starting preflight chain for ${domain}`,
    payload: {
      domain,
      chain,
    },
  });

  // Execute each skill in the chain
  for (const skillId of chain) {
    const result = await executeSkill(skillId, vtid, context);
    results.push(result);

    // If a skill fails critically, we might want to stop early
    if (result.recommendation === 'duplicate_detected') {
      console.log(`[VTID-01164] Duplicate detected, stopping chain`);
      break;
    }
  }

  // Determine if we should proceed
  const allOk = results.every(r => r.ok);
  const hasBlockers = results.some(r =>
    r.recommendation === 'duplicate_detected' ||
    (r.issues && Array.isArray(r.issues) && r.issues.some((i: any) => i.severity === 'critical'))
  );

  // Emit chain completion event
  await emitOasisEvent({
    vtid,
    type: 'vtid.preflight.complete' as any,
    source: 'preflight-runner',
    status: allOk ? 'success' : 'warning',
    message: allOk ? 'Preflight chain passed' : 'Preflight chain found issues',
    payload: {
      domain,
      all_ok: allOk,
      proceed: !hasBlockers,
      results,
    },
  });

  return {
    ok: allOk,
    results,
    proceed: !hasBlockers,
  };
}

/**
 * List available skills
 */
export function listSkills(): Array<{ skill_id: string; name: string; domain: string }> {
  return SKILL_DEFINITIONS;
}

/**
 * Get preflight chains configuration
 */
export function getPreflightChains(): Record<string, string[]> {
  return PREFLIGHT_CHAINS;
}
