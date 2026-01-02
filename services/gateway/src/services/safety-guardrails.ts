/**
 * VTID-01122: Safety-Aware Reasoning Guardrails Service
 *
 * Deterministic safety guardrails that constrain ORB's reasoning,
 * recommendations, and actions BEFORE output is generated.
 *
 * Core Principles:
 * - Intelligence must be powerful — but never unsafe
 * - Same inputs → same decision (deterministic)
 * - No guardrail bypass
 * - All decisions logged and traceable
 * - Safety decisions precede response generation
 */

import { randomUUID, createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import type { CicdEventType } from '../types/cicd';
import {
  SafetyDomain,
  GuardrailAction,
  GuardrailInput,
  GuardrailEvaluation,
  DomainGuardrailResult,
  GuardrailRule,
  GuardrailCondition,
  RuleEvaluationTrace,
  ConfidenceScore,
  SAFETY_DOMAINS,
  GUARDRAIL_ACTION_PRIORITY,
  HARD_CONSTRAINTS
} from '../types/safety-guardrails';
import {
  GUARDRAIL_RULE_VERSION,
  GUARDRAIL_RULES_BY_DOMAIN,
  getActiveRulesForDomain,
  DEFAULT_USER_MESSAGES,
  DOMAIN_DETECTION_PATTERNS
} from './safety-guardrail-rules';

// =============================================================================
// HELPER: Input Hashing (for determinism verification)
// =============================================================================

/**
 * Create a deterministic hash of the guardrail input.
 * Used to verify that same inputs produce same outputs.
 */
function hashGuardrailInput(input: GuardrailInput): string {
  const normalized = JSON.stringify({
    intent: input.intent_bundle.primary_intent,
    intent_id: input.intent_bundle.intent_id,
    routing: input.routing_bundle.recommended_route,
    user_role: input.user_role,
    autonomy: input.autonomy_intent,
    emotional_state: input.emotional_signals.primary_emotion,
    stress: input.emotional_signals.stress_indicators,
    vulnerability: input.emotional_signals.vulnerability_indicators
  });

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// =============================================================================
// HELPER: Deep Field Access
// =============================================================================

/**
 * Access a nested field using dot notation.
 * e.g., 'intent_bundle.primary_intent' → input.intent_bundle.primary_intent
 */
function getFieldValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// =============================================================================
// HELPER: Condition Evaluation
// =============================================================================

/**
 * Evaluate a single condition against the input.
 * Returns whether the condition matches.
 */
function evaluateCondition(
  condition: GuardrailCondition,
  input: GuardrailInput,
  evaluationContext: Record<string, unknown>
): { matched: boolean; actual: unknown } {
  // Combine input and evaluation context for field access
  const combined: Record<string, unknown> = {
    ...input,
    _evaluation: evaluationContext
  };

  const actual = getFieldValue(combined, condition.field);
  const expected = condition.value;

  let matched = false;

  switch (condition.operator) {
    case 'eq':
      matched = actual === expected;
      break;

    case 'neq':
      matched = actual !== expected;
      break;

    case 'contains':
      if (typeof actual === 'string' && typeof expected === 'string') {
        matched = condition.case_sensitive !== false
          ? actual.includes(expected)
          : actual.toLowerCase().includes(expected.toLowerCase());
      } else if (Array.isArray(actual)) {
        matched = actual.includes(expected);
      }
      break;

    case 'not_contains':
      if (typeof actual === 'string' && typeof expected === 'string') {
        matched = condition.case_sensitive !== false
          ? !actual.includes(expected)
          : !actual.toLowerCase().includes(expected.toLowerCase());
      } else if (Array.isArray(actual)) {
        matched = !actual.includes(expected);
      }
      break;

    case 'gt':
      matched = typeof actual === 'number' && typeof expected === 'number' && actual > expected;
      break;

    case 'lt':
      matched = typeof actual === 'number' && typeof expected === 'number' && actual < expected;
      break;

    case 'gte':
      matched = typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
      break;

    case 'lte':
      matched = typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
      break;

    case 'matches':
      if (typeof actual === 'string' && typeof expected === 'string') {
        try {
          const regex = new RegExp(expected, condition.case_sensitive === false ? 'i' : undefined);
          matched = regex.test(actual);
        } catch {
          matched = false;
        }
      }
      break;

    case 'in':
      if (Array.isArray(expected)) {
        matched = expected.includes(actual);
      }
      break;

    case 'not_in':
      if (Array.isArray(expected)) {
        matched = !expected.includes(actual);
      }
      break;

    default:
      matched = false;
  }

  return { matched, actual };
}

// =============================================================================
// HELPER: Rule Evaluation
// =============================================================================

/**
 * Evaluate a single rule against the input.
 * All conditions must match for the rule to trigger.
 */
function evaluateRule(
  rule: GuardrailRule,
  input: GuardrailInput,
  evaluationContext: Record<string, unknown>
): RuleEvaluationTrace {
  const startTime = Date.now();
  const conditionsEvaluated: RuleEvaluationTrace['conditions_evaluated'] = [];

  let allMatched = true;

  for (const condition of rule.conditions) {
    const result = evaluateCondition(condition, input, evaluationContext);

    conditionsEvaluated.push({
      field: condition.field,
      operator: condition.operator,
      expected: condition.value,
      actual: result.actual,
      matched: result.matched
    });

    if (!result.matched) {
      allMatched = false;
      // Don't break early - we want to trace all conditions for debugging
    }
  }

  return {
    rule_id: rule.rule_id,
    matched: allMatched,
    conditions_evaluated: conditionsEvaluated,
    evaluation_time_ms: Date.now() - startTime
  };
}

// =============================================================================
// HELPER: Domain Detection
// =============================================================================

/**
 * Detect relevant domains from the input text.
 * Uses keyword patterns for initial classification.
 */
function detectRelevantDomains(input: GuardrailInput): SafetyDomain[] {
  const relevantDomains: SafetyDomain[] = [];
  const textToSearch = [
    input.intent_bundle.raw_input,
    input.intent_bundle.primary_intent,
    ...(input.intent_bundle.secondary_intents || [])
  ].join(' ').toLowerCase();

  for (const domain of SAFETY_DOMAINS) {
    const patterns = DOMAIN_DETECTION_PATTERNS[domain];

    // Check high-signal keywords first
    for (const keyword of patterns.high_signal) {
      if (textToSearch.includes(keyword.toLowerCase())) {
        if (!relevantDomains.includes(domain)) {
          relevantDomains.push(domain);
        }
        break;
      }
    }

    // If no high-signal match, check medium-signal
    if (!relevantDomains.includes(domain)) {
      let mediumSignalCount = 0;
      for (const keyword of patterns.medium_signal) {
        if (textToSearch.includes(keyword.toLowerCase())) {
          mediumSignalCount++;
          if (mediumSignalCount >= 2) {
            relevantDomains.push(domain);
            break;
          }
        }
      }
    }
  }

  // Always include 'system' domain for autonomy and bypass checks
  if (!relevantDomains.includes('system')) {
    relevantDomains.push('system');
  }

  return relevantDomains;
}

// =============================================================================
// HELPER: Get Minimum Confidence
// =============================================================================

/**
 * Get the minimum confidence score from all scores.
 */
function getMinConfidence(scores: ConfidenceScore[]): number {
  if (scores.length === 0) return 1.0;
  return Math.min(...scores.map(s => s.score));
}

// =============================================================================
// CORE: Domain Evaluation
// =============================================================================

/**
 * Evaluate a single domain's rules against the input.
 * Returns the most restrictive action triggered.
 */
function evaluateDomain(
  domain: SafetyDomain,
  input: GuardrailInput,
  evaluationContext: Record<string, unknown>
): DomainGuardrailResult {
  const rules = getActiveRulesForDomain(domain);
  const triggeredRules: string[] = [];
  let mostRestrictiveAction: GuardrailAction = 'allow';
  let mostRestrictiveRule: GuardrailRule | null = null;

  for (const rule of rules) {
    const trace = evaluateRule(rule, input, evaluationContext);

    if (trace.matched) {
      triggeredRules.push(rule.rule_id);

      // Check if this action is more restrictive
      const currentPriority = GUARDRAIL_ACTION_PRIORITY[mostRestrictiveAction];
      const rulePriority = GUARDRAIL_ACTION_PRIORITY[rule.action];

      if (rulePriority < currentPriority) {
        mostRestrictiveAction = rule.action;
        mostRestrictiveRule = rule;
      }
    }
  }

  // Get explanation from rule or default
  let explanationCode = 'DOMAIN_ALLOWED';
  let explanationText = '';

  if (mostRestrictiveRule) {
    explanationCode = mostRestrictiveRule.explanation_code;
    explanationText = mostRestrictiveRule.explanation_template;
  } else if (mostRestrictiveAction !== 'allow') {
    const defaultMsg = DEFAULT_USER_MESSAGES[domain][mostRestrictiveAction];
    explanationText = defaultMsg.message;
    explanationCode = `${domain.toUpperCase()}_${mostRestrictiveAction.toUpperCase()}`;
  }

  return {
    domain,
    action: mostRestrictiveAction,
    triggered_rules: triggeredRules,
    explanation_code: explanationCode,
    explanation_text: explanationText,
    confidence: 1.0 // Deterministic - always 100% confident in rule evaluation
  };
}

// =============================================================================
// CORE: Full Guardrail Evaluation
// =============================================================================

/**
 * Evaluate all safety guardrails for the given input.
 * This is the main entry point for guardrail evaluation.
 *
 * CRITICAL: This function MUST be called BEFORE any response generation.
 */
export async function evaluateGuardrails(
  input: GuardrailInput
): Promise<GuardrailEvaluation> {
  const evaluationId = `sge_${randomUUID()}`;
  const startTime = Date.now();

  // Create input hash for determinism verification
  const inputHash = hashGuardrailInput(input);

  // Detect relevant domains
  const relevantDomains = detectRelevantDomains(input);

  // Build evaluation context
  const evaluationContext: Record<string, unknown> = {
    min_confidence: getMinConfidence(input.confidence_scores),
    has_block: false,
    has_restrict: false,
    has_redirect: false
  };

  // Evaluate each relevant domain
  const domainResults: DomainGuardrailResult[] = [];

  for (const domain of relevantDomains) {
    const result = evaluateDomain(domain, input, evaluationContext);
    domainResults.push(result);

    // Update context for cross-domain rules (system domain)
    if (result.action === 'block') {
      evaluationContext.has_block = true;
    }
    if (result.action === 'restrict') {
      evaluationContext.has_restrict = true;
    }
    if (result.action === 'redirect') {
      evaluationContext.has_redirect = true;
    }
  }

  // Re-evaluate system domain with updated context if needed
  if (evaluationContext.has_block || evaluationContext.has_restrict) {
    const systemIndex = domainResults.findIndex(r => r.domain === 'system');
    if (systemIndex >= 0) {
      const systemResult = evaluateDomain('system', input, evaluationContext);
      domainResults[systemIndex] = systemResult;
    }
  }

  // Determine final action (most restrictive wins)
  let finalAction: GuardrailAction = 'allow';
  let primaryDomain: SafetyDomain | null = null;

  for (const result of domainResults) {
    const currentPriority = GUARDRAIL_ACTION_PRIORITY[finalAction];
    const resultPriority = GUARDRAIL_ACTION_PRIORITY[result.action];

    if (resultPriority < currentPriority) {
      finalAction = result.action;
      primaryDomain = result.domain;
    }
  }

  // Build user message if not allowed
  let userMessage: string | undefined;
  let alternatives: string[] | undefined;

  if (finalAction !== 'allow' && primaryDomain) {
    const primaryResult = domainResults.find(r => r.domain === primaryDomain);

    if (primaryResult && primaryResult.explanation_text) {
      userMessage = primaryResult.explanation_text;
    } else {
      const defaultMsg = DEFAULT_USER_MESSAGES[primaryDomain][finalAction];
      userMessage = defaultMsg.message;
      alternatives = defaultMsg.alternatives;
    }

    // Get alternatives from triggered rules
    const triggeredRuleIds = domainResults.flatMap(r => r.triggered_rules);
    const allRules = GUARDRAIL_RULES_BY_DOMAIN[primaryDomain] || [];

    for (const ruleId of triggeredRuleIds) {
      const rule = allRules.find(r => r.rule_id === ruleId);
      if (rule?.alternatives_template && rule.alternatives_template.length > 0) {
        alternatives = rule.alternatives_template;
        break;
      }
    }
  }

  const evaluationDurationMs = Date.now() - startTime;

  // Build evaluation result
  const evaluation: GuardrailEvaluation = {
    evaluation_id: evaluationId,
    request_id: input.request_id,
    session_id: input.session_id,
    tenant_id: input.tenant_id,
    final_action: finalAction,
    primary_domain: primaryDomain,
    domain_results: domainResults,
    user_message: userMessage,
    alternatives,
    input_hash: inputHash,
    rule_version: GUARDRAIL_RULE_VERSION,
    evaluated_at: new Date().toISOString(),
    evaluation_duration_ms: evaluationDurationMs
  };

  // Emit OASIS event
  await emitSafetyGuardrailEvent(evaluation, input);

  return evaluation;
}

// =============================================================================
// OASIS EVENT EMISSION
// =============================================================================

/**
 * Emit a safety guardrail evaluation event to OASIS.
 */
async function emitSafetyGuardrailEvent(
  evaluation: GuardrailEvaluation,
  input: GuardrailInput
): Promise<void> {
  const eventType = mapActionToEventType(evaluation.final_action);

  try {
    await emitOasisEvent({
      vtid: 'VTID-01122',
      type: eventType,
      source: 'safety-guardrails',
      status: evaluation.final_action === 'allow' ? 'success' :
              evaluation.final_action === 'block' ? 'warning' : 'info',
      message: `Safety guardrail ${evaluation.final_action}: ${evaluation.primary_domain || 'none'}`,
      payload: {
        evaluation_id: evaluation.evaluation_id,
        request_id: evaluation.request_id,
        session_id: evaluation.session_id,
        tenant_id: evaluation.tenant_id,
        final_action: evaluation.final_action,
        primary_domain: evaluation.primary_domain,
        triggered_rules: evaluation.domain_results.flatMap(r => r.triggered_rules),
        domains_evaluated: evaluation.domain_results.map(r => r.domain),
        input_hash: evaluation.input_hash,
        rule_version: evaluation.rule_version,
        evaluation_duration_ms: evaluation.evaluation_duration_ms,
        user_role: input.user_role,
        autonomy_requested: input.autonomy_intent.autonomy_requested,
        autonomy_denied: evaluation.final_action !== 'allow' &&
                         input.autonomy_intent.autonomy_requested,
        evaluated_at: evaluation.evaluated_at
      }
    });
  } catch (error) {
    console.error('[VTID-01122] Failed to emit safety guardrail event:', error);
    // Don't throw - logging failure shouldn't block safety evaluation
  }
}

/**
 * Map guardrail action to OASIS event type.
 */
function mapActionToEventType(action: GuardrailAction): CicdEventType {
  switch (action) {
    case 'allow':
      return 'safety.guardrail.allowed';
    case 'restrict':
      return 'safety.guardrail.restricted';
    case 'redirect':
      return 'safety.guardrail.redirected';
    case 'block':
      return 'safety.guardrail.blocked';
    default:
      return 'safety.guardrail.evaluated';
  }
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Quick check if a response is allowed.
 * Use this for fast-path checks before full evaluation.
 */
export function isResponseAllowed(evaluation: GuardrailEvaluation): boolean {
  return evaluation.final_action === 'allow';
}

/**
 * Quick check if autonomy is permitted.
 * Returns false if any block or restrict is in effect.
 */
export function isAutonomyPermitted(evaluation: GuardrailEvaluation): boolean {
  // Hard constraint: no autonomy under block or restrict
  if (HARD_CONSTRAINTS.NO_AUTONOMY_UNDER_BLOCK && evaluation.final_action === 'block') {
    return false;
  }
  if (HARD_CONSTRAINTS.NO_AUTONOMY_UNDER_RESTRICT && evaluation.final_action === 'restrict') {
    return false;
  }
  return true;
}

/**
 * Get the user-facing message for a guardrail result.
 */
export function getUserMessage(evaluation: GuardrailEvaluation): string | null {
  if (evaluation.final_action === 'allow') {
    return null;
  }
  return evaluation.user_message || null;
}

/**
 * Get alternatives when blocked or restricted.
 */
export function getAlternatives(evaluation: GuardrailEvaluation): string[] {
  return evaluation.alternatives || [];
}

/**
 * Create a minimal input bundle for testing.
 */
export function createMinimalInput(
  rawInput: string,
  userRole: 'patient' | 'professional' | 'admin' | 'system' = 'patient'
): GuardrailInput {
  const now = new Date().toISOString();
  const requestId = `req_${randomUUID()}`;

  return {
    intent_bundle: {
      intent_id: `int_${randomUUID()}`,
      raw_input: rawInput,
      primary_intent: 'unknown',
      extracted_entities: {},
      is_question: rawInput.includes('?'),
      is_request: true,
      is_command: false,
      extracted_at: now
    },
    routing_bundle: {
      routing_id: `rte_${randomUUID()}`,
      intent_id: requestId,
      recommended_route: 'default',
      alternative_routes: [],
      requires_context: false,
      requires_memory: false,
      requires_external_data: false,
      routed_at: now
    },
    confidence_scores: [{
      score_id: `scr_${randomUUID()}`,
      target_type: 'intent',
      target_id: requestId,
      score: 0.8,
      uncertainty_band: { lower: 0.7, upper: 0.9 },
      calibration_method: 'heuristic',
      factors: [],
      scored_at: now
    }],
    emotional_signals: {
      signal_id: `emo_${randomUUID()}`,
      detected_emotions: [],
      sentiment_score: 0,
      communication_style: 'neutral',
      stress_indicators: false,
      vulnerability_indicators: false,
      detected_at: now
    },
    user_role: userRole,
    autonomy_intent: {
      autonomy_requested: false,
      autonomy_level: 'none'
    },
    tenant_id: 'default',
    session_id: `ses_${randomUUID()}`,
    request_id: requestId
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  GUARDRAIL_RULE_VERSION,
  SAFETY_DOMAINS,
  GUARDRAIL_ACTION_PRIORITY,
  HARD_CONSTRAINTS
};

export default {
  evaluateGuardrails,
  isResponseAllowed,
  isAutonomyPermitted,
  getUserMessage,
  getAlternatives,
  createMinimalInput,
  GUARDRAIL_RULE_VERSION,
  SAFETY_DOMAINS,
  GUARDRAIL_ACTION_PRIORITY,
  HARD_CONSTRAINTS
};
