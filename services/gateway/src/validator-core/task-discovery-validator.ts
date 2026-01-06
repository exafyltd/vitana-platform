/**
 * VTID-01160: Governance Validator — OASIS_ONLY_TASK_TRUTH
 *
 * HARD GOVERNANCE (NON-NEGOTIABLE):
 * This validator enforces that ALL task state queries MUST source from OASIS.
 *
 * Rule ID: GOV-INTEL-R.1
 * Name: OASIS_ONLY_TASK_TRUTH
 * Severity: CRITICAL
 * Applies to: ORB, Operator Console, MCP tool callers
 * Trigger: TASK_STATE_QUERY intent
 *
 * Rule Statements:
 * 1. Source of truth for task state MUST be OASIS
 * 2. Allowed discovery tool: mcp__vitana-work__discover_tasks only
 * 3. Task identifiers MUST match ^VTID-\d{4,5}$
 * 4. DEV-/ADM-/AICOR-* may only appear in ignored[] as legacy artifacts
 *
 * Enforcement:
 * - If not satisfied: BLOCK response
 * - Emit OASIS event: governance.violation.oasis_only_task_truth
 * - Return user-facing: "Blocked by governance: task status must come from OASIS."
 */

import {
    TaskDiscoveryContext,
    TaskDiscoveryValidationResult,
    TaskDiscoveryError,
    TaskDiscoveryViolationPayload,
    TaskDiscoverySurface,
    TaskStateSource,
    VTID_FORMAT,
} from '../types/governance';

// =============================================================================
// Constants
// =============================================================================

/** Rule identifier for this governance rule */
export const RULE_ID = 'GOV-INTEL-R.1';

/** Rule name for this governance rule */
export const RULE_NAME = 'OASIS_ONLY_TASK_TRUTH';

/** User-facing message when blocked */
export const BLOCKED_MESSAGE = 'Blocked by governance: task status must come from OASIS.';

/** Required tool for task discovery */
export const REQUIRED_DISCOVERY_TOOL = 'mcp__vitana-work__discover_tasks';

// =============================================================================
// Validator Class
// =============================================================================

/**
 * VTID-01160: Task Discovery Validator
 *
 * Validates that task state queries comply with OASIS_ONLY_TASK_TRUTH governance rule.
 */
export class TaskDiscoveryValidator {
    /**
     * Validate a task discovery context against the OASIS_ONLY_TASK_TRUTH rule
     *
     * @param context - The task discovery context to validate
     * @returns Validation result with pass/block action and any errors
     */
    validate(context: TaskDiscoveryContext): TaskDiscoveryValidationResult {
        const errors: TaskDiscoveryError[] = [];

        // 1. Check source of truth is OASIS
        if (context.detected_source !== 'oasis') {
            errors.push({
                code: 'INVALID_SOURCE',
                message: `Task state must come from OASIS, not ${context.detected_source}`,
                value: context.detected_source,
            });
        }

        // 2. Check discover_tasks tool was used
        if (!context.used_discover_tasks) {
            errors.push({
                code: 'MISSING_DISCOVER_TASKS',
                message: `Task discovery must use ${REQUIRED_DISCOVERY_TOOL}`,
            });
        }

        // 3. Check response source_of_truth field
        if (context.response_source_of_truth && context.response_source_of_truth !== 'OASIS') {
            errors.push({
                code: 'INVALID_SOURCE',
                message: `Response source_of_truth must be "OASIS", got "${context.response_source_of_truth}"`,
                value: context.response_source_of_truth,
            });
        }

        // 4. Validate VTID formats
        if (context.task_ids && context.task_ids.length > 0) {
            for (const taskId of context.task_ids) {
                // Check for legacy patterns first
                const legacyMatch = this.isLegacyId(taskId);
                if (legacyMatch) {
                    errors.push({
                        code: 'LEGACY_ID_DETECTED',
                        message: `Legacy task ID format detected (${legacyMatch}). Only VTID-\\d{4,5} format allowed.`,
                        value: taskId,
                    });
                    continue;
                }

                // Check for valid VTID format
                if (!this.isValidVtidFormat(taskId)) {
                    errors.push({
                        code: 'INVALID_VTID_FORMAT',
                        message: `Invalid VTID format. Expected VTID-\\d{4,5}, got: ${taskId}`,
                        value: taskId,
                    });
                }
            }
        }

        // 5. Validate pending statuses (if provided)
        if (context.pending_statuses && context.pending_statuses.length > 0) {
            const allowedStatuses = VTID_FORMAT.ALLOWED_PENDING_STATUSES as readonly string[];
            for (const status of context.pending_statuses) {
                if (!allowedStatuses.includes(status)) {
                    errors.push({
                        code: 'INVALID_STATUS',
                        message: `Invalid pending status "${status}". Allowed: ${allowedStatuses.join(', ')}`,
                        value: status,
                    });
                }
            }
        }

        // Determine result
        if (errors.length === 0) {
            return {
                valid: true,
                action: 'pass',
                errors: [],
            };
        }

        // Determine if this is a block or retry situation
        const hasSourceError = errors.some(e => e.code === 'INVALID_SOURCE' || e.code === 'MISSING_DISCOVER_TASKS');

        return {
            valid: false,
            action: 'block',
            reason: errors.map(e => e.message).join('; '),
            user_message: BLOCKED_MESSAGE,
            retry_action: hasSourceError ? 'discover_tasks_required' : undefined,
            errors,
        };
    }

    /**
     * Check if a task ID matches the valid VTID format (VTID-\d{4,5})
     */
    isValidVtidFormat(taskId: string): boolean {
        return VTID_FORMAT.PATTERN.test(taskId);
    }

    /**
     * Check if a task ID matches a legacy pattern
     * @returns The matching pattern string if legacy, undefined otherwise
     */
    isLegacyId(taskId: string): string | undefined {
        for (const pattern of VTID_FORMAT.LEGACY_PATTERNS) {
            if (pattern.test(taskId)) {
                return pattern.source;
            }
        }
        return undefined;
    }

    /**
     * Create a violation payload for OASIS logging
     */
    createViolationPayload(
        context: TaskDiscoveryContext,
        errors: TaskDiscoveryError[]
    ): TaskDiscoveryViolationPayload {
        const invalidTaskIds = errors
            .filter(e => e.code === 'INVALID_VTID_FORMAT' || e.code === 'LEGACY_ID_DETECTED')
            .map(e => e.value)
            .filter((v): v is string => v !== undefined);

        return {
            rule_id: 'GOV-INTEL-R.1',
            rule_name: 'OASIS_ONLY_TASK_TRUTH',
            status: 'blocked',
            surface: context.surface,
            detected_source: context.detected_source,
            requested_query: context.requested_query,
            retry_action: 'discover_tasks_required',
            invalid_task_ids: invalidTaskIds.length > 0 ? invalidTaskIds : undefined,
            violated_at: new Date().toISOString(),
        };
    }

    /**
     * Quick check if a query intent is a task state query
     * Uses simple heuristics to detect task-related queries
     */
    isTaskStateQuery(query: string): boolean {
        const lowerQuery = query.toLowerCase();
        const taskQueryPatterns = [
            /what.*tasks?/,
            /pending.*tasks?/,
            /task.*status/,
            /scheduled.*tasks?/,
            /in.?progress.*tasks?/,
            /allocated.*tasks?/,
            /current.*tasks?/,
            /my.*tasks?/,
            /list.*tasks?/,
            /show.*tasks?/,
            /vtid/i,
        ];

        return taskQueryPatterns.some(pattern => pattern.test(lowerQuery));
    }
}

// =============================================================================
// Factory & Singleton
// =============================================================================

let validatorInstance: TaskDiscoveryValidator | null = null;

/**
 * Get the singleton TaskDiscoveryValidator instance
 */
export function getTaskDiscoveryValidator(): TaskDiscoveryValidator {
    if (!validatorInstance) {
        validatorInstance = new TaskDiscoveryValidator();
    }
    return validatorInstance;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Detect the source of task data from a response
 *
 * @param response - The response object to analyze
 * @returns The detected source type
 */
export function detectTaskSource(response: {
    source_of_truth?: string;
    tool_used?: string;
    data_origin?: string;
}): TaskStateSource {
    // Explicit source_of_truth field
    if (response.source_of_truth === 'OASIS') {
        return 'oasis';
    }

    // Check tool used
    if (response.tool_used === REQUIRED_DISCOVERY_TOOL) {
        return 'oasis';
    }

    // Check data origin
    if (response.data_origin) {
        const origin = response.data_origin.toLowerCase();
        if (origin.includes('repo') || origin.includes('file') || origin.includes('scan')) {
            return 'repo_scan';
        }
        if (origin.includes('memory') || origin.includes('cache')) {
            return 'memory';
        }
    }

    return 'unknown';
}

/**
 * Extract task IDs from a response payload
 *
 * @param response - The response to extract IDs from
 * @returns Array of task IDs found
 */
export function extractTaskIds(response: {
    pending?: Array<{ vtid: string }>;
    tasks?: Array<{ vtid?: string; id?: string }>;
    task_ids?: string[];
}): string[] {
    const ids: string[] = [];

    // From discover_tasks response
    if (response.pending) {
        ids.push(...response.pending.map(t => t.vtid));
    }

    // From generic tasks array
    if (response.tasks) {
        for (const task of response.tasks) {
            if (task.vtid) ids.push(task.vtid);
            else if (task.id) ids.push(task.id);
        }
    }

    // From explicit task_ids field
    if (response.task_ids) {
        ids.push(...response.task_ids);
    }

    return [...new Set(ids)]; // Dedupe
}

/**
 * Build a TaskDiscoveryContext from request/response data
 */
export function buildTaskDiscoveryContext(params: {
    surface: TaskDiscoverySurface;
    query: string;
    response?: {
        source_of_truth?: string;
        pending?: Array<{ vtid: string; status?: string }>;
    };
    tool_used?: string;
}): TaskDiscoveryContext {
    const { surface, query, response, tool_used } = params;

    const taskIds = response?.pending?.map(t => t.vtid) || [];
    const pendingStatuses = response?.pending?.map(t => t.status).filter((s): s is string => !!s) || [];

    return {
        surface,
        detected_source: response?.source_of_truth === 'OASIS' ? 'oasis' :
                         tool_used === REQUIRED_DISCOVERY_TOOL ? 'oasis' : 'unknown',
        requested_query: query,
        used_discover_tasks: tool_used === REQUIRED_DISCOVERY_TOOL,
        task_ids: taskIds.length > 0 ? taskIds : undefined,
        response_source_of_truth: response?.source_of_truth,
        pending_statuses: pendingStatuses.length > 0 ? pendingStatuses : undefined,
    };
}

// Export types for convenience
export type { TaskDiscoveryContext, TaskDiscoveryValidationResult, TaskDiscoveryError };
