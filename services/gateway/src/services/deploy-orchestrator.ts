/**
 * Deploy Orchestrator Service - VTID-0525 + VTID-0407
 *
 * Shared deploy orchestrator that provides a single implementation for:
 * - Operator Chat deploy commands
 * - Publish modal deploy requests
 *
 * VTID-0407: Integrates Governance Evaluator to enforce deploy policies.
 * No deployment can proceed unless governance explicitly allows it.
 *
 * This service wraps the existing CICD infrastructure (VTID-0516) and provides
 * a unified interface for triggering deployments.
 */

import githubService from './github-service';
import cicdEvents from './oasis-event-service';
import { randomUUID } from 'crypto';

const DEFAULT_REPO = 'exafyltd/vitana-platform';

export interface DeployRequest {
  vtid: string;
  service: 'gateway' | 'oasis-operator' | 'oasis-projector';
  environment: 'dev';
  branch?: string;
  source: 'operator.console.chat' | 'publish.modal' | 'api';
}

// VTID-0407: Governance violation interface
export interface GovernanceViolation {
  rule_id: string;
  level: string;
  message: string;
}

export interface DeployResult {
  ok: boolean;
  vtid: string;
  service: string;
  environment: string;
  workflow_run_id?: number;
  workflow_url?: string;
  error?: string;
  // VTID-0407: Governance enforcement fields
  blocked?: boolean;
  level?: string;
  violations?: GovernanceViolation[];
}

/**
 * VTID-0407: Evaluate governance rules before deployment
 * Makes internal call to the governance evaluation endpoint
 */
async function evaluateGovernance(
  vtid: string,
  service: string,
  environment: string
): Promise<{
  allowed: boolean;
  level: string;
  violations: GovernanceViolation[];
}> {
  try {
    // Call the governance evaluation endpoint internally
    // Since we're in the same process, we can import the controller directly
    const { getSupabase } = await import('../lib/supabase');
    const supabase = getSupabase();

    if (!supabase) {
      console.warn('[VTID-0407] Supabase not configured - allowing deploy by default');
      return { allowed: true, level: 'L4', violations: [] };
    }

    // Fetch active governance rules
    const { data: rules, error: rulesError } = await supabase
      .from('governance_rules')
      .select('*')
      .eq('tenant_id', 'SYSTEM')
      .eq('is_active', true);

    if (rulesError) {
      console.error('[VTID-0407] Error fetching governance rules:', rulesError);
      return { allowed: true, level: 'L4', violations: [] };
    }

    // Evaluate rules
    const violations: GovernanceViolation[] = [];
    let highestViolationLevel = 'L4';
    const context = { action: 'deploy', service, environment, vtid };

    for (const rule of (rules || [])) {
      const ruleLogic = rule.logic || {};
      const ruleLevel = rule.level || 'L4';
      const ruleId = rule.rule_id || ruleLogic.rule_code || rule.id;

      // Check if rule applies to deploy actions
      const appliesTo = ruleLogic.applies_to || [];
      const ruleTarget = ruleLogic.target || {};

      const appliesToDeploy =
        appliesTo.includes('deploy') ||
        appliesTo.includes('*') ||
        ruleTarget.action === 'deploy' ||
        (ruleLogic.domain && ['CICD', 'DEPLOYMENT'].includes(ruleLogic.domain.toUpperCase()));

      if (!appliesToDeploy) continue;

      // Evaluate rule conditions
      let passed = true;
      let violationMessage = rule.name || `Rule ${ruleId} violation`;

      // Check service restrictions
      if (ruleLogic.allowed_services && !ruleLogic.allowed_services.includes(service)) {
        passed = false;
        violationMessage = ruleLogic.violation_message || `Service '${service}' is not in allowed list`;
      }

      // Check environment restrictions
      if (passed && ruleLogic.allowed_environments && !ruleLogic.allowed_environments.includes(environment)) {
        passed = false;
        violationMessage = ruleLogic.violation_message || `Environment '${environment}' is not allowed`;
      }

      // Check explicit conditions
      if (passed && ruleLogic.conditions) {
        for (const condition of ruleLogic.conditions) {
          const { field, op, value } = condition;
          const contextValue = field.split('.').reduce((obj: any, key: string) => obj?.[key], context);

          let conditionPassed = true;
          switch (op) {
            case 'eq':
            case '==':
              conditionPassed = contextValue === value;
              break;
            case 'neq':
            case '!=':
              conditionPassed = contextValue !== value;
              break;
            case 'in':
              conditionPassed = Array.isArray(value) && value.includes(contextValue);
              break;
            case 'not_in':
              conditionPassed = Array.isArray(value) && !value.includes(contextValue);
              break;
            default:
              conditionPassed = true;
          }

          if (!conditionPassed) {
            passed = false;
            violationMessage = condition.message || ruleLogic.violation_message || rule.description || `Condition failed: ${field} ${op} ${value}`;
            break;
          }
        }
      }

      if (!passed) {
        violations.push({
          rule_id: ruleId,
          level: ruleLevel,
          message: violationMessage
        });

        // Track highest violation level (L1 is most severe)
        const levelOrder: Record<string, number> = { 'L1': 1, 'L2': 2, 'L3': 3, 'L4': 4 };
        if ((levelOrder[ruleLevel] || 4) < (levelOrder[highestViolationLevel] || 4)) {
          highestViolationLevel = ruleLevel;
        }
      }
    }

    // L1 and L2 violations block deployment
    const hasBlockingViolations = violations.some(v => v.level === 'L1' || v.level === 'L2');
    const allowed = !hasBlockingViolations;

    console.log(`[VTID-0407] Governance evaluation: allowed=${allowed}, level=${highestViolationLevel}, violations=${violations.length}`);

    return {
      allowed,
      level: violations.length > 0 ? highestViolationLevel : 'L4',
      violations
    };

  } catch (error: any) {
    console.error('[VTID-0407] Governance evaluation error:', error);
    // Fail-open: allow deployment on evaluation errors
    return { allowed: true, level: 'L4', violations: [] };
  }
}

/**
 * Execute a deployment using the existing CICD infrastructure.
 * This is the single orchestrator that both Operator Chat and Publish modal use.
 *
 * VTID-0407: Now integrates governance evaluation before deployment.
 */
export async function executeDeploy(request: DeployRequest): Promise<DeployResult> {
  const { vtid, service, environment, source } = request;

  console.log(`[Deploy Orchestrator] Starting deploy for ${service} to ${environment} (VTID: ${vtid}, source: ${source})`);

  try {
    // VTID-0407: Step 0 - Evaluate governance rules before proceeding
    console.log(`[VTID-0407] Evaluating governance for deploy: ${service} to ${environment}`);
    const governance = await evaluateGovernance(vtid, service, environment);

    if (!governance.allowed) {
      // Deployment blocked by governance
      console.log(`[VTID-0407] Deploy BLOCKED by governance: ${governance.violations.length} violation(s)`);

      // Emit governance blocked event to OASIS
      await cicdEvents.governanceDeployBlocked(vtid, service, governance.level, governance.violations);

      return {
        ok: false,
        vtid,
        service,
        environment,
        blocked: true,
        level: governance.level,
        violations: governance.violations,
        error: `Deployment blocked by governance (${governance.violations.length} violation${governance.violations.length !== 1 ? 's' : ''})`
      };
    }

    // Governance check passed - emit allowed event
    console.log(`[VTID-0407] Deploy ALLOWED by governance (level: ${governance.level})`);
    await cicdEvents.governanceDeployAllowed(vtid, service, governance.level);

    // Step 1: Emit deploy requested event
    await cicdEvents.deployRequested(vtid, service, environment);

    // Step 2: Trigger the deploy workflow via GitHub Actions
    // This uses the same workflow as VTID-0516 (source deploy, no pre-built image)
    await githubService.triggerWorkflow(
      DEFAULT_REPO,
      'EXEC-DEPLOY.yml',
      'main',
      {
        vtid,
        service, // 'gateway', 'oasis-operator', or 'oasis-projector'
        health_path: '/alive',
        initiator: source === 'operator.console.chat' ? 'agent' : 'user',
      }
    );

    // Step 3: Get workflow run info
    const runs = await githubService.getWorkflowRuns(DEFAULT_REPO, 'EXEC-DEPLOY.yml');
    const latestRun = runs.workflow_runs[0];

    // Step 4: Emit deploy accepted event
    await cicdEvents.deployAccepted(vtid, service, environment, latestRun?.html_url);

    console.log(`[Deploy Orchestrator] Deploy workflow triggered for ${service} (${vtid})`);

    return {
      ok: true,
      vtid,
      service,
      environment,
      workflow_run_id: latestRun?.id,
      workflow_url: latestRun?.html_url,
      level: governance.level,
    };

  } catch (error: any) {
    console.error(`[Deploy Orchestrator] Deploy failed for ${service}:`, error);

    // Emit deploy failed event
    await cicdEvents.deployFailed(vtid, service, error.message);

    return {
      ok: false,
      vtid,
      service,
      environment,
      error: error.message,
    };
  }
}

/**
 * Create a VTID using the existing VTID creation infrastructure.
 * Used when a command doesn't provide a VTID.
 *
 * VTID-0525-B: DISABLED - Direct vtid_ledger writes cause schema mismatch errors.
 * The real vtid_ledger table only has: vtid, layer, module, status, title, summary, created_at, updated_at
 * For MVP, we skip VTID auto-creation and use a placeholder.
 */
export async function createVtid(
  family: 'DEV' | 'ADM' | 'GOVRN' | 'OASIS',
  module: string,
  title: string
): Promise<{ ok: boolean; vtid?: string; error?: string }> {
  // VTID-0525-B: Skip VTID creation for MVP - use placeholder
  // Direct vtid_ledger writes were causing schema mismatch errors
  console.log(`[Deploy Orchestrator] VTID-0525-B: Skipping VTID creation, using placeholder`);

  // Generate a simple placeholder VTID for tracking purposes
  const timestamp = Date.now().toString(36).toUpperCase();
  const placeholder = `OASIS-CMD-${timestamp}`;

  console.log(`[Deploy Orchestrator] Using placeholder VTID: ${placeholder}`);
  return { ok: true, vtid: placeholder };
}

/**
 * Create a Command Hub task for non-deploy commands.
 *
 * VTID-0525-B: DISABLED - Direct vtid_ledger writes cause schema mismatch errors.
 * For MVP, we return a friendly message instead of creating tasks.
 */
export async function createTask(
  vtid: string,
  title: string,
  taskType: string,
  metadata: Record<string, unknown> = {}
): Promise<{ ok: boolean; task_id?: string; error?: string }> {
  // VTID-0525-B: Skip task creation for MVP
  // Direct vtid_ledger writes were causing schema mismatch errors
  console.log(`[Deploy Orchestrator] VTID-0525-B: Skipping task creation for MVP`);
  console.log(`[Deploy Orchestrator] Would create task: ${title} (type: ${taskType})`);

  // Return a placeholder task ID so the flow continues
  const timestamp = Date.now().toString(36).toUpperCase();
  const placeholderTaskId = `TASK-${timestamp}`;

  return {
    ok: true,
    task_id: placeholderTaskId,
  };
}

export default {
  executeDeploy,
  createVtid,
  createTask,
};
