/**
 * Skill Registry - VTID-01164
 *
 * Central registry for all worker skills. Provides skill lookup,
 * execution, and preflight chain management.
 */

import {
  SkillDefinition,
  SkillResult,
  SkillContext,
  CheckMemoryFirstParams,
  CheckMemoryFirstResult,
  SecurityScanParams,
  SecurityScanResult,
  ValidateRlsPolicyParams,
  ValidateRlsPolicyResult,
  PreviewMigrationParams,
  PreviewMigrationResult,
  AnalyzeServiceParams,
  AnalyzeServiceResult,
  ValidateAccessibilityParams,
  ValidateAccessibilityResult,
} from './types';
import { createSkillEmitter } from './oasisEmitter';
import { checkMemoryFirst } from './checkMemoryFirst';
import { securityScan } from './securityScan';
import { validateRlsPolicy } from './validateRlsPolicy';
import { previewMigration } from './previewMigration';
import { analyzeService } from './analyzeService';
import { validateAccessibility } from './validateAccessibility';

// =============================================================================
// Skill Registry
// =============================================================================

/**
 * All registered skills
 */
const SKILL_REGISTRY: Map<string, SkillDefinition<unknown, SkillResult>> = new Map();

/**
 * Register a skill
 */
function registerSkill<P, R extends SkillResult>(skill: SkillDefinition<P, R>): void {
  SKILL_REGISTRY.set(skill.skill_id, skill as unknown as SkillDefinition<unknown, SkillResult>);
}

// Register all skills
registerSkill<CheckMemoryFirstParams, CheckMemoryFirstResult>({
  skill_id: 'worker.common.check_memory_first',
  name: 'Check Memory First',
  domain: 'common',
  handler: checkMemoryFirst,
  timeout_ms: 30000,
});

registerSkill<SecurityScanParams, SecurityScanResult>({
  skill_id: 'worker.backend.security_scan',
  name: 'Backend Security Scan',
  domain: 'backend',
  handler: securityScan,
  timeout_ms: 60000,
});

registerSkill<ValidateRlsPolicyParams, ValidateRlsPolicyResult>({
  skill_id: 'worker.memory.validate_rls_policy',
  name: 'Validate RLS Policy',
  domain: 'memory',
  handler: validateRlsPolicy,
  timeout_ms: 30000,
});

registerSkill<PreviewMigrationParams, PreviewMigrationResult>({
  skill_id: 'worker.memory.preview_migration',
  name: 'Preview Migration',
  domain: 'memory',
  handler: previewMigration,
  timeout_ms: 30000,
});

registerSkill<AnalyzeServiceParams, AnalyzeServiceResult>({
  skill_id: 'worker.backend.analyze_service',
  name: 'Analyze Service',
  domain: 'backend',
  handler: analyzeService,
  timeout_ms: 60000,
});

registerSkill<ValidateAccessibilityParams, ValidateAccessibilityResult>({
  skill_id: 'worker.frontend.validate_accessibility',
  name: 'Validate Accessibility',
  domain: 'frontend',
  handler: validateAccessibility,
  timeout_ms: 30000,
});

// =============================================================================
// Skill Execution
// =============================================================================

/**
 * Get a skill by ID
 */
export function getSkill(skillId: string): SkillDefinition<unknown, SkillResult> | undefined {
  return SKILL_REGISTRY.get(skillId);
}

/**
 * List all registered skills
 */
export function listSkills(): Array<{ skill_id: string; name: string; domain: string }> {
  return Array.from(SKILL_REGISTRY.values()).map(skill => ({
    skill_id: skill.skill_id,
    name: skill.name,
    domain: skill.domain,
  }));
}

/**
 * Execute a skill with timeout
 */
export async function executeSkill<P, R extends SkillResult>(
  skillId: string,
  params: P,
  vtid: string,
  runId?: string
): Promise<R & { _execution: { skill_id: string; duration_ms: number; timed_out: boolean } }> {
  const skill = SKILL_REGISTRY.get(skillId);

  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`);
  }

  const actualRunId = runId || `skill_${Date.now()}`;
  const startTime = Date.now();

  // Create context with emitter
  const context: SkillContext = {
    vtid,
    run_id: actualRunId,
    domain: skill.domain,
    emitEvent: createSkillEmitter(vtid, skillId, skill.domain),
  };

  // Execute with timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Skill execution timed out')), skill.timeout_ms);
  });

  try {
    const result = await Promise.race([
      skill.handler(params, context) as Promise<R>,
      timeoutPromise,
    ]);

    const duration = Date.now() - startTime;

    return {
      ...result,
      _execution: {
        skill_id: skillId,
        duration_ms: duration,
        timed_out: false,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const isTimeout = error instanceof Error && error.message.includes('timed out');

    // Emit timeout event if applicable
    if (isTimeout) {
      await context.emitEvent('timeout', 'error', `Skill execution timed out after ${skill.timeout_ms}ms`, {
        timeout_ms: skill.timeout_ms,
        actual_duration_ms: duration,
      });
    }

    throw Object.assign(error, {
      _execution: {
        skill_id: skillId,
        duration_ms: duration,
        timed_out: isTimeout,
      },
    });
  }
}

// =============================================================================
// Preflight Chain
// =============================================================================

/**
 * Preflight chain configuration for each domain
 */
export const PREFLIGHT_CHAINS: Record<string, string[]> = {
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

/**
 * Post-flight (validation) chain for each domain
 */
export const POSTFLIGHT_CHAINS: Record<string, string[]> = {
  frontend: [
    'worker.frontend.validate_accessibility',
  ],
  backend: [
    'worker.backend.security_scan',
  ],
  memory: [
    'worker.memory.validate_rls_policy',
  ],
};

/**
 * Execute preflight chain for a domain
 */
export async function runPreflightChain(
  domain: 'frontend' | 'backend' | 'memory',
  vtid: string,
  context: {
    query: string;
    target_paths: string[];
  }
): Promise<{
  ok: boolean;
  results: Array<{ skill_id: string; ok: boolean; recommendation?: string; issues?: unknown[] }>;
  proceed: boolean;
}> {
  const chain = PREFLIGHT_CHAINS[domain] || [];
  const results: Array<{ skill_id: string; ok: boolean; recommendation?: string; issues?: unknown[] }> = [];

  for (const skillId of chain) {
    try {
      let result: SkillResult & { recommendation?: string; issues?: unknown[] };

      // Build params based on skill
      if (skillId === 'worker.common.check_memory_first') {
        result = await executeSkill(skillId, {
          vtid,
          query: context.query,
          target_paths: context.target_paths,
        }, vtid);
      } else if (skillId === 'worker.backend.analyze_service') {
        result = await executeSkill(skillId, {
          vtid,
          feature_description: context.query,
          file_patterns: context.target_paths.length > 0
            ? context.target_paths
            : ['services/gateway/src/routes/**', 'services/gateway/src/services/**'],
        }, vtid);
      } else if (skillId === 'worker.backend.security_scan') {
        result = await executeSkill(skillId, {
          vtid,
          target_paths: context.target_paths,
        }, vtid);
      } else if (skillId === 'worker.memory.validate_rls_policy') {
        result = await executeSkill(skillId, {
          vtid,
          file_paths: context.target_paths.filter(p => p.endsWith('.sql')),
        }, vtid);
      } else if (skillId === 'worker.memory.preview_migration') {
        const sqlPaths = context.target_paths.filter(p => p.endsWith('.sql'));
        if (sqlPaths.length > 0) {
          result = await executeSkill(skillId, {
            vtid,
            file_path: sqlPaths[0],
          }, vtid);
        } else {
          result = { ok: true };
        }
      } else if (skillId === 'worker.frontend.validate_accessibility') {
        result = await executeSkill(skillId, {
          vtid,
          target_paths: context.target_paths,
        }, vtid);
      } else {
        result = { ok: true };
      }

      results.push({
        skill_id: skillId,
        ok: result.ok,
        recommendation: (result as any).recommendation,
        issues: (result as any).issues || (result as any).findings || (result as any).violations,
      });

    } catch (error) {
      results.push({
        skill_id: skillId,
        ok: false,
        recommendation: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Determine if we should proceed
  const allOk = results.every(r => r.ok);
  const hasBlockers = results.some(r =>
    r.recommendation === 'duplicate_detected' ||
    (r.issues && Array.isArray(r.issues) && r.issues.some((i: any) => i.severity === 'critical'))
  );

  return {
    ok: allOk,
    results,
    proceed: !hasBlockers,
  };
}

// =============================================================================
// Exports
// =============================================================================

export {
  CheckMemoryFirstParams,
  CheckMemoryFirstResult,
  SecurityScanParams,
  SecurityScanResult,
  ValidateRlsPolicyParams,
  ValidateRlsPolicyResult,
  PreviewMigrationParams,
  PreviewMigrationResult,
  AnalyzeServiceParams,
  AnalyzeServiceResult,
  ValidateAccessibilityParams,
  ValidateAccessibilityResult,
} from './types';
