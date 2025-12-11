/**
 * Governance Evaluation Engine v1
 * VTID-0404: Deterministic rule evaluation for proposed actions
 *
 * This engine is the hard gate used by:
 * - Validator agent
 * - Orchestrator (VTID-0533)
 * - CI/CD automated checks
 * - Manual evaluation from Command Hub
 */

import { getSupabase } from '../supabase';

// Input payload structure for evaluation requests
export interface EvaluateActionPayload {
  action: 'deploy' | 'modify' | 'delete' | 'create' | 'route_change' | 'csp_change';
  service: string;
  environment: 'dev' | 'staging' | 'prod';
  files?: string[];
  metadata?: {
    vtid?: string;
    author?: string;
    description?: string;
    deployMethod?: string;
    routePath?: string;
    cspDirectives?: Record<string, string[]>;
    fileContents?: Record<string, string>;
  };
}

// Output structure for evaluation results
export interface EvaluationResult {
  allowed: boolean;
  violatedRules: string[];
  reasons: string[];
  evaluatedAt: string;
  vtid: string;
  metadata?: Record<string, any>;
}

// Governance rule from database
export interface GovernanceRuleRecord {
  id: string;
  tenant_id: string;
  rule_id: string;
  name: string;
  description: string;
  level: 'L1' | 'L2' | 'L3' | 'L4';
  logic: Record<string, any>;
  is_active: boolean;
  enforcement: string[];
  sources: string[];
  vtids: string[];
}

// Canonical rule IDs that MUST be checked
const CORE_RULES = {
  SYS_RULE_DEPLOY_L1: 'SYS-RULE-DEPLOY-L1',
  GOV_FRONTEND_001: 'GOV-FRONTEND-001',
  GOV_FRONTEND_002: 'GOV-FRONTEND-002',
  GOV_FRONTEND_003: 'GOV-FRONTEND-003',
  GOV_MIGRATION_002: 'GOV-MIGRATION-002',
  GOV_AGENT_003: 'GOV-AGENT-003',
};

// Forbidden inline script patterns for CSP check
const INLINE_SCRIPT_PATTERNS = [
  /<script[^>]*>[\s\S]*?<\/script>/gi,
  /\son\w+\s*=/gi, // onclick, onload, etc.
  /javascript:/gi,
];

// Forbidden CDN patterns
const CDN_PATTERNS = [
  /cdn\.jsdelivr\.net/gi,
  /cdnjs\.cloudflare\.com/gi,
  /unpkg\.com/gi,
  /cdn\.skypack\.dev/gi,
];

// Forbidden CSP directives
const FORBIDDEN_CSP_VALUES = [
  "'unsafe-inline'",
  "'unsafe-eval'",
];

// Canonical frontend paths
const CANONICAL_FRONTEND_PATH = 'services/gateway/src/frontend/command-hub';
const FORBIDDEN_FRONTEND_PATHS = [
  'static/command-hub',
  'public/command-hub',
  'frontend/command-hub',
  'dist/command-hub',
];

// Allowed deploy methods (SYS-RULE-DEPLOY-L1)
const ALLOWED_DEPLOY_METHODS = [
  'deploy-service.sh',
  'scripts/deploy/deploy-service.sh',
  './scripts/deploy/deploy-service.sh',
];

/**
 * Main Governance Evaluation Engine class
 */
export class GovernanceEvaluator {
  private tenantId: string;

  constructor(tenantId: string = 'SYSTEM') {
    this.tenantId = tenantId;
  }

  /**
   * Load all active governance rules from Supabase
   */
  async loadRulesFromDatabase(): Promise<GovernanceRuleRecord[]> {
    const supabase = getSupabase();

    if (!supabase) {
      console.error('[GovernanceEvaluator] Supabase not configured - using hardcoded rules only');
      return [];
    }

    try {
      const { data, error } = await supabase
        .from('governance_rules')
        .select('*')
        .eq('is_active', true)
        .eq('tenant_id', this.tenantId);

      if (error) {
        console.error('[GovernanceEvaluator] Error loading rules:', error);
        return [];
      }

      return (data || []) as GovernanceRuleRecord[];
    } catch (err) {
      console.error('[GovernanceEvaluator] Failed to load rules:', err);
      return [];
    }
  }

  /**
   * Main evaluation function - evaluates an action against all rules
   */
  async evaluateActionAgainstRules(payload: EvaluateActionPayload): Promise<EvaluationResult> {
    const violations: { ruleId: string; reason: string }[] = [];
    const evaluatedAt = new Date().toISOString();

    // Load rules from database
    const dbRules = await this.loadRulesFromDatabase();
    console.log(`[GovernanceEvaluator] Loaded ${dbRules.length} rules from database`);

    // Always check hardcoded critical rules regardless of database state
    // This ensures governance enforcement even if DB is unavailable

    // 1. Check CSP rules (GOV-FRONTEND-003)
    const cspViolations = this.checkCSP(payload);
    violations.push(...cspViolations);

    // 2. Check deploy rules (SYS-RULE-DEPLOY-L1)
    const deployViolations = this.checkDeployRules(payload);
    violations.push(...deployViolations);

    // 3. Check navigation/frontend canonical rules (GOV-FRONTEND-001)
    const navViolations = this.checkNavigationRules(payload);
    violations.push(...navViolations);

    // 4. Check Start Stream semantics (no hardcoded rules yet, but check file patterns)
    const streamViolations = this.checkStartStreamSemantics(payload);
    violations.push(...streamViolations);

    // 5. Check static asset rules
    const assetViolations = this.checkStaticAssetRules(payload);
    violations.push(...assetViolations);

    // 6. Check route mount rules
    const routeViolations = this.checkRouteMountRules(payload);
    violations.push(...routeViolations);

    // 7. Evaluate database rules
    for (const rule of dbRules) {
      const ruleViolation = this.evaluateDatabaseRule(rule, payload);
      if (ruleViolation) {
        violations.push(ruleViolation);
      }
    }

    // Deduplicate violations by rule ID
    const uniqueViolations = violations.reduce((acc, v) => {
      if (!acc.find(x => x.ruleId === v.ruleId)) {
        acc.push(v);
      }
      return acc;
    }, [] as typeof violations);

    return {
      allowed: uniqueViolations.length === 0,
      violatedRules: uniqueViolations.map(v => v.ruleId),
      reasons: uniqueViolations.map(v => v.reason),
      evaluatedAt,
      vtid: 'VTID-0404',
      metadata: {
        action: payload.action,
        service: payload.service,
        environment: payload.environment,
        totalRulesChecked: dbRules.length + 6, // DB rules + hardcoded checks
        requestVtid: payload.metadata?.vtid,
      },
    };
  }

  /**
   * Check CSP compliance (GOV-FRONTEND-003)
   * - No inline scripts
   * - No unsafe-inline
   * - No CDN imports
   */
  checkCSP(payload: EvaluateActionPayload): { ruleId: string; reason: string }[] {
    const violations: { ruleId: string; reason: string }[] = [];

    // Check file contents for inline scripts
    if (payload.metadata?.fileContents) {
      for (const [filePath, content] of Object.entries(payload.metadata.fileContents)) {
        // Only check frontend files (JS, HTML, TS, TSX)
        if (!/\.(js|ts|tsx|html|htm)$/i.test(filePath)) continue;

        // Check for inline script patterns
        for (const pattern of INLINE_SCRIPT_PATTERNS) {
          if (pattern.test(content)) {
            violations.push({
              ruleId: CORE_RULES.GOV_FRONTEND_003,
              reason: `Inline scripts detected in modified file: ${filePath}`,
            });
            break;
          }
        }

        // Check for CDN imports
        for (const pattern of CDN_PATTERNS) {
          if (pattern.test(content)) {
            violations.push({
              ruleId: CORE_RULES.GOV_FRONTEND_003,
              reason: `CDN import detected in file: ${filePath} - use local dependencies`,
            });
            break;
          }
        }
      }
    }

    // Check CSP directives in metadata
    if (payload.metadata?.cspDirectives) {
      for (const [directive, values] of Object.entries(payload.metadata.cspDirectives)) {
        for (const value of values) {
          if (FORBIDDEN_CSP_VALUES.includes(value)) {
            violations.push({
              ruleId: CORE_RULES.GOV_FRONTEND_003,
              reason: `Forbidden CSP value '${value}' in directive '${directive}'`,
            });
          }
        }
      }
    }

    return violations;
  }

  /**
   * Check deployment rules (SYS-RULE-DEPLOY-L1)
   * - Deployment must use deploy-service.sh script only
   */
  checkDeployRules(payload: EvaluateActionPayload): { ruleId: string; reason: string }[] {
    const violations: { ruleId: string; reason: string }[] = [];

    if (payload.action === 'deploy') {
      const deployMethod = payload.metadata?.deployMethod;

      // If no deploy method specified, it's suspicious
      if (!deployMethod) {
        violations.push({
          ruleId: CORE_RULES.SYS_RULE_DEPLOY_L1,
          reason: 'Deployment method not specified - must use deploy-service.sh',
        });
      } else if (!ALLOWED_DEPLOY_METHODS.some(m => deployMethod.includes(m))) {
        violations.push({
          ruleId: CORE_RULES.SYS_RULE_DEPLOY_L1,
          reason: `Deployment attempted via ${deployMethod} - must use deploy-service.sh only`,
        });
      }
    }

    return violations;
  }

  /**
   * Check navigation and frontend canonical source rules (GOV-FRONTEND-001, GOV-FRONTEND-002)
   * - Only canonical path allowed for Command Hub
   */
  checkNavigationRules(payload: EvaluateActionPayload): { ruleId: string; reason: string }[] {
    const violations: { ruleId: string; reason: string }[] = [];

    if (payload.files && payload.files.length > 0) {
      for (const filePath of payload.files) {
        // Check for forbidden frontend paths
        for (const forbidden of FORBIDDEN_FRONTEND_PATHS) {
          if (filePath.includes(forbidden)) {
            violations.push({
              ruleId: CORE_RULES.GOV_FRONTEND_001,
              reason: `File path '${filePath}' violates canonical source rule - use ${CANONICAL_FRONTEND_PATH}`,
            });
            break;
          }
        }

        // Check if modifying navigation config - flag for review
        if (filePath.includes('navigation-config') && payload.action === 'modify') {
          violations.push({
            ruleId: CORE_RULES.GOV_FRONTEND_002,
            reason: `Modification to navigation config requires OASIS spec update first`,
          });
        }
      }
    }

    return violations;
  }

  /**
   * Check Start Stream semantics rules
   * - Ensure stream initialization follows protocol
   */
  checkStartStreamSemantics(payload: EvaluateActionPayload): { ruleId: string; reason: string }[] {
    const violations: { ruleId: string; reason: string }[] = [];

    // Check for improper stream handling in file contents
    if (payload.metadata?.fileContents) {
      for (const [filePath, content] of Object.entries(payload.metadata.fileContents)) {
        // Check for stream-related code that might bypass initialization
        if (filePath.includes('sse') || filePath.includes('stream')) {
          // Look for direct event emission without proper initialization
          if (content.includes('emit(') && !content.includes('initializeStream')) {
            violations.push({
              ruleId: 'GOV-STREAM-001',
              reason: `Stream event emission without initialization in ${filePath}`,
            });
          }
        }
      }
    }

    return violations;
  }

  /**
   * Check static asset rules
   * - Ensure assets are in correct locations
   * - No dynamic asset generation in restricted paths
   */
  checkStaticAssetRules(payload: EvaluateActionPayload): { ruleId: string; reason: string }[] {
    const violations: { ruleId: string; reason: string }[] = [];

    if (payload.files && payload.files.length > 0) {
      for (const filePath of payload.files) {
        // Check for static assets outside canonical path
        if (/\.(css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)$/i.test(filePath)) {
          if (!filePath.includes(CANONICAL_FRONTEND_PATH) && !filePath.includes('public/')) {
            violations.push({
              ruleId: 'GOV-ASSET-001',
              reason: `Static asset '${filePath}' is outside canonical frontend path`,
            });
          }
        }
      }
    }

    return violations;
  }

  /**
   * Check route mount rules
   * - Verify route path derivation
   * - Ensure no conflicting mounts
   */
  checkRouteMountRules(payload: EvaluateActionPayload): { ruleId: string; reason: string }[] {
    const violations: { ruleId: string; reason: string }[] = [];

    // Check route changes
    if (payload.action === 'route_change' && payload.metadata?.routePath) {
      const routePath = payload.metadata.routePath;

      // Verify API versioning
      if (routePath.startsWith('/api/') && !routePath.startsWith('/api/v1/')) {
        violations.push({
          ruleId: 'GOV-ROUTE-001',
          reason: `Route '${routePath}' must use versioned API path (e.g., /api/v1/...)`,
        });
      }

      // Check for conflicting governance route
      if (routePath.startsWith('/api/v1/governance') && !routePath.startsWith('/api/v1/governance/')) {
        violations.push({
          ruleId: 'GOV-ROUTE-002',
          reason: `Invalid governance route mount - must be under /api/v1/governance/`,
        });
      }
    }

    return violations;
  }

  /**
   * Evaluate a database rule against the payload
   */
  private evaluateDatabaseRule(
    rule: GovernanceRuleRecord,
    payload: EvaluateActionPayload
  ): { ruleId: string; reason: string } | null {
    // Check if rule applies to this action type
    if (!this.ruleAppliesToAction(rule, payload)) {
      return null;
    }

    // Execute rule logic if defined
    if (rule.logic && Object.keys(rule.logic).length > 0) {
      const isPass = this.executeRuleLogic(rule.logic, payload);
      if (!isPass) {
        return {
          ruleId: rule.rule_id || rule.id,
          reason: rule.description || `Violation of rule ${rule.name}`,
        };
      }
    }

    return null;
  }

  /**
   * Check if a rule applies to the given action
   */
  private ruleAppliesToAction(rule: GovernanceRuleRecord, payload: EvaluateActionPayload): boolean {
    // Check enforcement scope
    if (rule.enforcement && rule.enforcement.length > 0) {
      const enforcementMap: Record<string, string[]> = {
        deploy: ['backend', 'CI'],
        modify: ['backend', 'frontend', 'agents'],
        delete: ['backend', 'DB'],
        create: ['backend', 'frontend'],
        route_change: ['backend'],
        csp_change: ['frontend', 'backend'],
      };

      const relevantEnforcement = enforcementMap[payload.action] || [];
      const hasOverlap = rule.enforcement.some(e => relevantEnforcement.includes(e));
      if (!hasOverlap) {
        return false;
      }
    }

    return true;
  }

  /**
   * Execute rule logic against payload data
   */
  private executeRuleLogic(logic: Record<string, any>, payload: EvaluateActionPayload): boolean {
    if (!logic.op) return true;

    const field = logic.field;
    const target = logic.value;

    // Get value from payload based on field path
    let value: any = payload;
    if (field) {
      const parts = field.split('.');
      for (const part of parts) {
        value = value?.[part];
      }
    }

    switch (logic.op) {
      case 'eq':
        return value === target;
      case 'neq':
        return value !== target;
      case 'contains':
        return Array.isArray(value) ? value.includes(target) : String(value).includes(target);
      case 'not_contains':
        return Array.isArray(value) ? !value.includes(target) : !String(value).includes(target);
      case 'matches':
        return new RegExp(target).test(String(value));
      case 'exists':
        return value !== undefined && value !== null;
      case 'not_exists':
        return value === undefined || value === null;
      default:
        // Unknown operator - fail safe (deny)
        return false;
    }
  }
}

/**
 * Log governance evaluation event to OASIS
 */
export async function logEvaluationToOasis(
  payload: EvaluateActionPayload,
  result: EvaluationResult
): Promise<void> {
  const supabase = getSupabase();

  if (!supabase) {
    console.warn('[GovernanceEvaluator] Supabase not configured - OASIS event not logged');
    return;
  }

  try {
    await supabase.from('oasis_events_v1').insert({
      rid: `GOV-EVAL-${Date.now()}`,
      tenant: 'SYSTEM',
      task_type: 'governance.evaluate',
      assignee_ai: 'Claude',
      status: result.allowed ? 'success' : 'error',
      notes: result.allowed
        ? `Action ${payload.action} on ${payload.service} allowed`
        : `Action ${payload.action} on ${payload.service} denied: ${result.violatedRules.join(', ')}`,
      metadata: {
        input: {
          action: payload.action,
          service: payload.service,
          environment: payload.environment,
          files: payload.files,
          vtid: payload.metadata?.vtid,
          author: payload.metadata?.author,
        },
        output: {
          allowed: result.allowed,
          violatedRules: result.violatedRules,
          reasons: result.reasons,
        },
        evaluatedAt: result.evaluatedAt,
      },
      schema_version: 1,
    });

    console.log(`[GovernanceEvaluator] OASIS event logged: governance.evaluate`);
  } catch (err) {
    console.error('[GovernanceEvaluator] Failed to log OASIS event:', err);
  }
}

// Export singleton instance for convenience
export const governanceEvaluator = new GovernanceEvaluator();
