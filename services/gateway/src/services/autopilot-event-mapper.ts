/**
 * Autopilot Event Mapper - VTID-01179
 *
 * Canonical mapping table from OASIS events to autopilot state transitions.
 * This is the SINGLE SOURCE OF TRUTH for event → transition mapping.
 *
 * Design principles:
 * - Strict forward-only transitions (never regress state)
 * - Support multiple event aliases (taxonomy variations)
 * - Deterministic and idempotent
 * - Full traceability
 */

import { AutopilotState } from './autopilot-controller';

// =============================================================================
// Types
// =============================================================================

/**
 * OASIS event record (from oasis_events table)
 */
export interface OasisEvent {
  id: string;
  created_at: string;
  vtid?: string;
  kind?: string;
  status?: string;
  title?: string;
  source?: string;
  layer?: string;
  module?: string;
  ref?: string;
  topic?: string;
  service?: string;
  role?: string;
  message?: string;
  meta?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  task_stage?: string;
}

/**
 * Event mapping rule
 */
export interface EventMappingRule {
  // Event type patterns to match (OR condition)
  eventTypes: string[];

  // Current state(s) that allow this transition
  fromStates: AutopilotState[];

  // Target state after transition
  toState: AutopilotState;

  // Action to trigger (optional)
  triggerAction?: AutopilotAction;

  // Additional conditions (optional)
  condition?: (event: OasisEvent, currentState: AutopilotState) => boolean;

  // Description for logging
  description: string;
}

/**
 * Autopilot actions that can be triggered by the event loop
 */
export type AutopilotAction =
  | 'dispatch'       // Dispatch to worker orchestrator
  | 'create_pr'      // Create PR (if not created by worker)
  | 'validate'       // Run pre-merge validation
  | 'merge'          // Trigger safe-merge
  | 'verify';        // Run post-deploy verification

/**
 * Mapping result
 */
export interface MappingResult {
  matched: boolean;
  rule?: EventMappingRule;
  toState?: AutopilotState;
  triggerAction?: AutopilotAction;
  reason?: string;
}

// =============================================================================
// State Ordering (for forward-only validation)
// =============================================================================

const STATE_ORDER: Record<AutopilotState, number> = {
  'allocated': 0,
  'in_progress': 1,
  'building': 2,
  'pr_created': 3,
  'reviewing': 4,
  'validated': 5,
  'merged': 6,
  'deploying': 7,
  'verifying': 8,
  'completed': 9,
  'failed': 10, // Can be reached from any state
};

/**
 * Check if transition is forward (or to failed)
 */
function isForwardTransition(from: AutopilotState, to: AutopilotState): boolean {
  if (to === 'failed') return true; // Failed is always allowed
  return STATE_ORDER[to] > STATE_ORDER[from];
}

// =============================================================================
// Canonical Event Mapping Table
// =============================================================================

/**
 * THE CANONICAL MAPPING TABLE
 *
 * Rules are evaluated in order. First match wins.
 * Event types support wildcards: * matches any suffix.
 */
export const EVENT_MAPPING_RULES: EventMappingRule[] = [
  // -------------------------------------------------------------------------
  // ALLOCATION → IN_PROGRESS (Worker dispatch accepted)
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      'vtid.lifecycle.allocated',
      'vtid.lifecycle.started',      // VTID-01179: Activate button from Command Hub
      'commandhub.task.scheduled',
      'autopilot.run.started',
    ],
    fromStates: ['allocated'],
    toState: 'in_progress',
    triggerAction: 'dispatch',
    description: 'VTID allocated/scheduled/activated - dispatch to worker',
  },
  {
    eventTypes: [
      'worker.dispatch.accepted',
      'worker.execution.started',
      'autopilot.worker.started',
      'worker.orchestrator.dispatch.accepted',
      'vtid.stage.worker_orchestrator.claimed',     // VTID-01183: Worker claimed task
      'vtid.stage.worker_orchestrator.started',     // VTID-01183: Worker started
    ],
    fromStates: ['allocated', 'in_progress'],
    toState: 'in_progress',
    description: 'Worker started execution',
  },

  // -------------------------------------------------------------------------
  // IN_PROGRESS → BUILDING
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      'worker.building',
      'worker.execution.building',
      'autopilot.worker.building',
      'vtid.stage.worker_orchestrator.building',    // VTID-01183: Worker building
      'vtid.stage.worker_backend.start',            // VTID-01163: Backend subagent started
      'vtid.stage.worker_frontend.start',           // VTID-01163: Frontend subagent started
    ],
    fromStates: ['in_progress'],
    toState: 'building',
    description: 'Worker actively building',
  },

  // -------------------------------------------------------------------------
  // BUILDING → PR_CREATED
  // -------------------------------------------------------------------------
  // Rule 1: Worker completed WITHOUT PR info - trigger create_pr action
  {
    eventTypes: [
      'worker.execution.completed',
      'autopilot.worker.completed',
      'worker.orchestrator.completed',
      'vtid.stage.worker_orchestrator.completed',   // VTID-01183: Worker completed
      'vtid.stage.worker_orchestrator.success',     // VTID-01163: Orchestrator success
    ],
    fromStates: ['in_progress', 'building'],
    toState: 'pr_created',
    triggerAction: 'create_pr',
    description: 'Worker completed without PR - trigger PR creation',
    condition: (event) => {
      // Only trigger PR creation if not already done
      const meta = event.metadata || event.meta || {};
      return !meta.pr_number && !meta.pr_url;
    },
  },
  // Rule 2: Worker completed WITH PR info - just transition (no action needed)
  {
    eventTypes: [
      'worker.execution.completed',
      'autopilot.worker.completed',
      'worker.orchestrator.completed',
      'vtid.stage.worker_orchestrator.completed',   // VTID-01183: Worker completed
      'vtid.stage.worker_orchestrator.success',     // VTID-01163: Orchestrator success
    ],
    fromStates: ['in_progress', 'building'],
    toState: 'pr_created',
    description: 'Worker completed with PR - mark PR created',
  },
  {
    eventTypes: [
      'cicd.github.create_pr.succeeded',
      'cicd.pr.created',
      'github.pr.created',
      'autopilot.pr.created',
      'worker.pr.created',
      'vtid.stage.worker_orchestrator.pr_created',  // VTID-01183: Worker PR created
    ],
    fromStates: ['in_progress', 'building', 'pr_created'],
    toState: 'pr_created',
    description: 'PR created successfully',
  },

  // -------------------------------------------------------------------------
  // PR_CREATED → REVIEWING (CI passed)
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      'cicd.ci.passed',
      'cicd.checks.passed',
      'github.checks.passed',
      'autopilot.ci.passed',
    ],
    fromStates: ['pr_created'],
    toState: 'reviewing',
    triggerAction: 'validate',
    description: 'CI passed - trigger validation',
  },

  // -------------------------------------------------------------------------
  // REVIEWING → VALIDATED (Validator passed)
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      'autopilot.validation.passed',
      'autopilot.validator.passed',
      'validator.passed',
    ],
    fromStates: ['pr_created', 'reviewing'],
    toState: 'validated',
    triggerAction: 'merge',
    description: 'Validation passed - trigger safe-merge',
  },
  {
    eventTypes: [
      'autopilot.validation.failed',
      'autopilot.validator.failed',
      'validator.failed',
    ],
    fromStates: ['pr_created', 'reviewing', 'validated'],
    toState: 'failed',
    description: 'Validation failed - mark failed',
  },

  // -------------------------------------------------------------------------
  // VALIDATED → MERGED
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      'cicd.github.safe_merge.executed',
      'cicd.merge.success',
      'github.merge.success',
      'autopilot.merge.completed',
      'cicd.github.merge.succeeded',
    ],
    fromStates: ['validated'],
    toState: 'merged',
    description: 'PR merged successfully',
    condition: (event, currentState) => {
      // Only allow merge if from validated state (validator pass required)
      return currentState === 'validated';
    },
  },

  // -------------------------------------------------------------------------
  // MERGED → DEPLOYING
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      'cicd.deploy.service.started',
      'deploy.gateway.started',
      'cicd.deploy.started',
      'autopilot.deploy.started',
      'deploy.service.started',
    ],
    fromStates: ['merged'],
    toState: 'deploying',
    description: 'Deploy workflow started',
  },

  // -------------------------------------------------------------------------
  // DEPLOYING → VERIFYING (Deploy succeeded)
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      'cicd.deploy.service.succeeded',
      'deploy.gateway.success',
      'cicd.deploy.succeeded',
      'autopilot.deploy.completed',
      'deploy.service.succeeded',
    ],
    fromStates: ['deploying'],
    toState: 'verifying',
    triggerAction: 'verify',
    description: 'Deploy succeeded - trigger verification',
  },

  // -------------------------------------------------------------------------
  // VERIFYING → COMPLETED (Verification passed)
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      'autopilot.verification.passed',
      'autopilot.verify.passed',
      'verification.passed',
    ],
    fromStates: ['verifying'],
    toState: 'completed',
    description: 'Verification passed - mark completed (terminalize)',
  },
  {
    eventTypes: [
      'autopilot.verification.failed',
      'autopilot.verify.failed',
      'verification.failed',
    ],
    fromStates: ['verifying'],
    toState: 'failed',
    description: 'Verification failed - mark failed',
  },

  // -------------------------------------------------------------------------
  // FAILURE EVENTS (from any non-terminal state)
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      'worker.execution.failed',
      'worker.dispatch.failed',
      'worker.orchestrator.failed',
      'vtid.stage.worker_orchestrator.failed',      // VTID-01183: Worker failed
      'vtid.stage.worker_backend.failed',           // VTID-01163: Backend subagent failed
      'vtid.stage.worker_frontend.failed',          // VTID-01163: Frontend subagent failed
    ],
    fromStates: ['allocated', 'in_progress', 'building'],
    toState: 'failed',
    description: 'Worker execution failed',
  },
  {
    eventTypes: [
      'cicd.github.create_pr.failed',
      'cicd.pr.failed',
      'github.pr.failed',
    ],
    fromStates: ['in_progress', 'building', 'pr_created'],
    toState: 'failed',
    description: 'PR creation failed',
  },
  {
    eventTypes: [
      'cicd.ci.failed',
      'cicd.checks.failed',
      'github.checks.failed',
    ],
    fromStates: ['pr_created', 'reviewing'],
    toState: 'failed',
    description: 'CI checks failed',
  },
  {
    eventTypes: [
      'cicd.github.safe_merge.failed',
      'cicd.merge.failed',
      'github.merge.failed',
    ],
    fromStates: ['validated'],
    toState: 'failed',
    description: 'Merge failed',
  },
  {
    eventTypes: [
      'cicd.deploy.service.failed',
      'deploy.gateway.failed',
      'cicd.deploy.failed',
      'deploy.service.failed',
    ],
    fromStates: ['merged', 'deploying'],
    toState: 'failed',
    description: 'Deploy failed',
  },

  // -------------------------------------------------------------------------
  // GENERIC ERROR CATCH-ALL
  // -------------------------------------------------------------------------
  {
    eventTypes: [
      '*.error',
      '*.failed',
    ],
    fromStates: ['allocated', 'in_progress', 'building', 'pr_created', 'reviewing', 'validated', 'merged', 'deploying', 'verifying'],
    toState: 'failed',
    description: 'Generic error/failure event',
    condition: (event) => {
      // Only match if event status indicates error
      return event.status === 'error' || event.status === 'failed';
    },
  },
];

// =============================================================================
// Event Type Matching
// =============================================================================

/**
 * Check if event type matches a pattern
 * Supports wildcard suffix: "*.failed" matches "cicd.deploy.failed"
 */
function matchesEventType(eventType: string, pattern: string): boolean {
  if (pattern === eventType) {
    return true;
  }

  // Wildcard suffix matching
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return eventType.endsWith(`.${suffix}`) || eventType === suffix;
  }

  return false;
}

/**
 * Normalize event type from OASIS event
 * Handles both 'kind' and 'topic' fields
 */
export function normalizeEventType(event: OasisEvent): string {
  // Prefer 'topic' for backward compatibility, then 'kind'
  return event.topic || event.kind || 'unknown';
}

// =============================================================================
// Mapping Function
// =============================================================================

/**
 * Map an OASIS event to an autopilot transition
 *
 * @param event - The OASIS event to process
 * @param currentState - Current autopilot state for the VTID
 * @returns Mapping result with transition details or null if no match
 */
export function mapEventToTransition(
  event: OasisEvent,
  currentState: AutopilotState
): MappingResult {
  const eventType = normalizeEventType(event);

  // Terminal states don't accept transitions
  if (currentState === 'completed' || currentState === 'failed') {
    return {
      matched: false,
      reason: `VTID is in terminal state: ${currentState}`,
    };
  }

  // Find matching rule
  for (const rule of EVENT_MAPPING_RULES) {
    // Check if event type matches any of the rule's patterns
    const typeMatches = rule.eventTypes.some(pattern =>
      matchesEventType(eventType, pattern)
    );

    if (!typeMatches) continue;

    // Check if current state is allowed
    if (!rule.fromStates.includes(currentState)) {
      continue;
    }

    // Check additional condition if present
    if (rule.condition && !rule.condition(event, currentState)) {
      continue;
    }

    // Validate forward-only transition
    if (!isForwardTransition(currentState, rule.toState)) {
      return {
        matched: false,
        reason: `Backward transition not allowed: ${currentState} → ${rule.toState}`,
      };
    }

    // Match found!
    return {
      matched: true,
      rule,
      toState: rule.toState,
      triggerAction: rule.triggerAction,
    };
  }

  // No matching rule found
  return {
    matched: false,
    reason: `No matching rule for event '${eventType}' in state '${currentState}'`,
  };
}

/**
 * Check if an event is relevant to autopilot processing
 * (Quick filter before full mapping)
 */
export function isAutopilotRelevantEvent(event: OasisEvent): boolean {
  // Must have a VTID
  if (!event.vtid) {
    return false;
  }

  // Must have a type
  const eventType = normalizeEventType(event);
  if (!eventType || eventType === 'unknown') {
    return false;
  }

  // Check if any rule could potentially match this event type
  for (const rule of EVENT_MAPPING_RULES) {
    if (rule.eventTypes.some(pattern => matchesEventType(eventType, pattern))) {
      return true;
    }
  }

  return false;
}

/**
 * Get all event types that are relevant to autopilot
 * (For documentation and filtering)
 */
export function getAutopilotEventTypes(): string[] {
  const types = new Set<string>();

  for (const rule of EVENT_MAPPING_RULES) {
    for (const type of rule.eventTypes) {
      types.add(type);
    }
  }

  return Array.from(types).sort();
}

/**
 * Get valid next states from current state
 */
export function getValidNextStates(currentState: AutopilotState): AutopilotState[] {
  const nextStates = new Set<AutopilotState>();

  for (const rule of EVENT_MAPPING_RULES) {
    if (rule.fromStates.includes(currentState)) {
      nextStates.add(rule.toState);
    }
  }

  return Array.from(nextStates);
}

// =============================================================================
// Exports
// =============================================================================

export default {
  mapEventToTransition,
  isAutopilotRelevantEvent,
  normalizeEventType,
  getAutopilotEventTypes,
  getValidNextStates,
  EVENT_MAPPING_RULES,
};
