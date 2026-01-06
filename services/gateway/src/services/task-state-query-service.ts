/**
 * VTID-01158: ORB Router Fix — Enforce OASIS-Only Task Discovery
 *
 * HARD GOVERNANCE (NON-NEGOTIABLE):
 * 1. For any user query about tasks/VTIDs/scheduled/pending/in progress/planning/status,
 *    ORB MUST use MCP discover_tasks (OASIS-only).
 * 2. NO fallback to repo scans, spec files, memory summaries, or cached lists.
 * 3. If MCP/OASIS is unavailable, ORB must return:
 *    "OASIS not reachable — cannot provide reliable task status."
 * 4. ORB must never present DEV-* as "scheduled tasks."
 *    DEV-* may only appear under ignored[] with reason ignored_by_contract.
 *
 * Intent Detection Triggers (EN/DE):
 * - task|tasks|vtid|scheduled|pending|in progress|planned|geplant|planung|status|board|kanban|allocated
 */

import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// VTID-01158: Configuration
// =============================================================================

/**
 * Keyword patterns for TASK_STATE_QUERY detection (spec section 2)
 * Minimum keywords: task|tasks|vtid|scheduled|pending|in progress|planned|geplant|planung|status|board|kanban|allocated
 */
const TASK_STATE_QUERY_PATTERNS: RegExp[] = [
  // English keywords
  /\b(tasks?|vtids?)\b/i,
  /\b(scheduled|pending|in[- ]?progress|allocated)\b/i,
  /\b(planned|planning)\b/i,
  /\b(board|kanban)\b/i,
  /\b(show|list|what|which)\s+(are\s+)?(the\s+)?(pending|scheduled|current|active)\s*(tasks?|vtids?)?\b/i,
  /\bstatus\s+(of\s+)?(tasks?|vtids?)?\b/i,
  /\b(task|vtid)\s+status\b/i,
  /\bwhat\s+is\s+(in\s+)?progress\b/i,
  /\bwhat\s+(tasks?|vtids?)\s+(are|is)\b/i,

  // German keywords (spec section 2)
  /\b(geplant|planung)\b/i,
  /\bwelche\s+(vtids?|aufgaben?)\s+(sind|ist)\b/i,
  /\bwas\s+ist\s+(pending|geplant|scheduled)\b/i,
  /\bin\s+planung\b/i,
  /\b(aufgaben?|task)\s*(board|liste|status)\b/i,
];

/**
 * OASIS Gateway endpoint configuration
 */
const GATEWAY_CONFIG = {
  BASE_URL: process.env.GATEWAY_BASE_URL || 'http://localhost:3000',
  TIMEOUT_MS: 10000,
  DEFAULT_TENANT: 'vitana',
  DEFAULT_ENVIRONMENT: 'dev_sandbox',
  DEFAULT_STATUSES: ['scheduled', 'allocated', 'in_progress'] as const,
  DEFAULT_LIMIT: 50,
};

// =============================================================================
// VTID-01158: Types
// =============================================================================

export interface TaskStateQueryResult {
  ok: boolean;
  source_of_truth: 'OASIS';
  response_text: string;
  pending: PendingTask[];
  ignored: IgnoredItem[];
  counts: {
    scheduled: number;
    allocated: number;
    in_progress: number;
    total_pending: number;
    ignored: number;
  };
  error?: string;
}

interface PendingTask {
  vtid: string;
  title: string;
  status: string;
  task_family: string;
  created_at: string;
  updated_at: string;
}

interface IgnoredItem {
  id: string;
  reason: 'ignored_by_contract';
  details: string;
}

interface OasisTaskResponse {
  ok: boolean;
  pending?: Array<{
    vtid: string;
    title: string;
    status: string;
    task_family: string;
    created_at: string;
    updated_at: string;
  }>;
  ignored?: Array<{
    id: string;
    reason: 'ignored_by_contract';
    details: string;
  }>;
  counts?: {
    pending: number;
    ignored: number;
  };
  error?: string;
}

// =============================================================================
// VTID-01158: Intent Detection (spec section 2)
// =============================================================================

/**
 * Detect if user message is a TASK_STATE_QUERY
 * Uses keyword + pattern match (no ML-only guess) per spec section 2
 *
 * @param message - User's input text
 * @returns true if message triggers TASK_STATE_QUERY
 */
export function isTaskStateQuery(message: string): boolean {
  const normalizedMessage = message.toLowerCase().trim();

  // Check against all patterns
  for (const pattern of TASK_STATE_QUERY_PATTERNS) {
    if (pattern.test(normalizedMessage)) {
      return true;
    }
  }

  return false;
}

/**
 * Get detailed intent detection info for debugging
 */
export function getTaskStateQueryDebugInfo(message: string): {
  is_task_state_query: boolean;
  matched_patterns: string[];
  normalized_input: string;
} {
  const normalizedMessage = message.toLowerCase().trim();
  const matchedPatterns: string[] = [];

  for (const pattern of TASK_STATE_QUERY_PATTERNS) {
    if (pattern.test(normalizedMessage)) {
      matchedPatterns.push(pattern.source);
    }
  }

  return {
    is_task_state_query: matchedPatterns.length > 0,
    matched_patterns: matchedPatterns,
    normalized_input: normalizedMessage,
  };
}

// =============================================================================
// VTID-01158: OASIS Task Discovery (spec section 1 & 3)
// =============================================================================

/**
 * Execute TASK_STATE_QUERY via OASIS discover_tasks (spec section 3)
 *
 * HARD GOVERNANCE:
 * - MUST call OASIS discover_tasks
 * - MUST NOT fallback to repo scans, spec files, memory summaries
 * - If OASIS unavailable, return error message per spec
 * - DEV-* MUST NOT appear in pending list (only in ignored[])
 *
 * @param options - Query options
 * @returns TaskStateQueryResult with formatted response
 */
export async function executeTaskStateQuery(options: {
  tenant?: string;
  environment?: string;
  statuses?: ('scheduled' | 'allocated' | 'in_progress')[];
  limit?: number;
} = {}): Promise<TaskStateQueryResult> {
  const {
    tenant = GATEWAY_CONFIG.DEFAULT_TENANT,
    environment = GATEWAY_CONFIG.DEFAULT_ENVIRONMENT,
    statuses = [...GATEWAY_CONFIG.DEFAULT_STATUSES],
    limit = GATEWAY_CONFIG.DEFAULT_LIMIT,
  } = options;

  try {
    // Call OASIS discover_tasks via gateway (spec section 1)
    const response = await fetchFromOasis({
      tenant,
      environment,
      statuses,
      limit,
    });

    if (!response.ok) {
      // OASIS returned error - do NOT fallback (spec section 0)
      const errorMsg = response.error || 'Unknown OASIS error';
      await logQueryEvent('failed', { tenant, environment, error: errorMsg });

      return {
        ok: false,
        source_of_truth: 'OASIS',
        response_text: 'OASIS not reachable — cannot provide reliable task status.',
        pending: [],
        ignored: [],
        counts: {
          scheduled: 0,
          allocated: 0,
          in_progress: 0,
          total_pending: 0,
          ignored: 0,
        },
        error: errorMsg,
      };
    }

    // Process response - pending[] contains only valid VTID-\d{4,5} tasks
    // ignored[] contains DEV-* and other invalid formats
    const pending = response.pending || [];
    const ignored = response.ignored || [];

    // Calculate status counts
    const statusCounts = {
      scheduled: pending.filter(t => t.status === 'scheduled').length,
      allocated: pending.filter(t => t.status === 'allocated').length,
      in_progress: pending.filter(t => t.status === 'in_progress').length,
    };

    // Format response text for ORB (spec section 3)
    const responseText = formatTaskStateResponse(pending, ignored, statusCounts);

    // Log successful query
    await logQueryEvent('success', {
      tenant,
      environment,
      pending_count: pending.length,
      ignored_count: ignored.length,
    });

    return {
      ok: true,
      source_of_truth: 'OASIS',
      response_text: responseText,
      pending,
      ignored,
      counts: {
        ...statusCounts,
        total_pending: pending.length,
        ignored: ignored.length,
      },
    };
  } catch (error) {
    // Network or other failure - do NOT fallback (spec section 0)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await logQueryEvent('failed', { tenant, environment, error: errorMessage });

    return {
      ok: false,
      source_of_truth: 'OASIS',
      response_text: 'OASIS not reachable — cannot provide reliable task status.',
      pending: [],
      ignored: [],
      counts: {
        scheduled: 0,
        allocated: 0,
        in_progress: 0,
        total_pending: 0,
        ignored: 0,
      },
      error: errorMessage,
    };
  }
}

// =============================================================================
// VTID-01158: Gateway Communication
// =============================================================================

/**
 * Fetch tasks from OASIS via gateway
 * This calls the same endpoint that the MCP discover_tasks tool uses
 */
async function fetchFromOasis(params: {
  tenant: string;
  environment: string;
  statuses: string[];
  limit: number;
}): Promise<OasisTaskResponse> {
  const { tenant, environment, statuses, limit } = params;

  const url = new URL('/api/v1/oasis/tasks/discover', GATEWAY_CONFIG.BASE_URL);
  url.searchParams.set('tenant', tenant);
  url.searchParams.set('environment', environment);
  url.searchParams.set('statuses', statuses.join(','));
  url.searchParams.set('limit', limit.toString());

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GATEWAY_CONFIG.TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Actor': 'orb-router',
        'X-VTID': 'VTID-01158',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json();
    return data as OasisTaskResponse;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      return {
        ok: false,
        error: 'OASIS request timeout',
      };
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Network error',
    };
  }
}

// =============================================================================
// VTID-01158: Response Formatting (spec section 3)
// =============================================================================

/**
 * Format task state response for ORB output (spec section 3)
 *
 * Required footer:
 * - Source: OASIS (via discover_tasks)
 * - counts: scheduled/allocated/in_progress totals
 */
function formatTaskStateResponse(
  pending: PendingTask[],
  ignored: IgnoredItem[],
  statusCounts: { scheduled: number; allocated: number; in_progress: number }
): string {
  const lines: string[] = [];

  // Header
  if (pending.length === 0) {
    lines.push('No pending tasks found in OASIS.');
  } else {
    lines.push(`Found ${pending.length} pending task(s):`);
    lines.push('');

    // Group by status
    const scheduled = pending.filter(t => t.status === 'scheduled');
    const allocated = pending.filter(t => t.status === 'allocated');
    const inProgress = pending.filter(t => t.status === 'in_progress');

    if (scheduled.length > 0) {
      lines.push('**Scheduled:**');
      for (const task of scheduled) {
        lines.push(`  - ${task.vtid}: ${task.title}`);
      }
      lines.push('');
    }

    if (allocated.length > 0) {
      lines.push('**Allocated:**');
      for (const task of allocated) {
        lines.push(`  - ${task.vtid}: ${task.title}`);
      }
      lines.push('');
    }

    if (inProgress.length > 0) {
      lines.push('**In Progress:**');
      for (const task of inProgress) {
        lines.push(`  - ${task.vtid}: ${task.title}`);
      }
      lines.push('');
    }
  }

  // Ignored section (optional, only if items exist) - spec section 3
  if (ignored.length > 0) {
    lines.push('---');
    lines.push('**Ignored (legacy):**');
    for (const item of ignored.slice(0, 5)) { // Limit to first 5
      lines.push(`  - ${item.id}: ${item.details}`);
    }
    if (ignored.length > 5) {
      lines.push(`  ... and ${ignored.length - 5} more ignored items`);
    }
    lines.push('');
  }

  // Footer - required per spec section 3
  lines.push('---');
  lines.push('Source: OASIS (via discover_tasks)');
  lines.push(`Counts: scheduled=${statusCounts.scheduled}, allocated=${statusCounts.allocated}, in_progress=${statusCounts.in_progress}`);

  return lines.join('\n');
}

// =============================================================================
// VTID-01158: OASIS Event Logging
// =============================================================================

/**
 * Log task state query event to OASIS
 */
async function logQueryEvent(
  status: 'success' | 'failed',
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: 'VTID-01158',
      type: 'orb.task_state_query',
      source: 'task-state-query-service',
      status: status === 'success' ? 'success' : 'error',
      message: status === 'success'
        ? 'Task state query completed via OASIS'
        : 'Task state query failed - OASIS unreachable',
      payload,
    });
  } catch (err) {
    console.warn('[VTID-01158] Failed to emit OASIS event:', err);
  }
}

// =============================================================================
// VTID-01158: Exports
// =============================================================================

export {
  TASK_STATE_QUERY_PATTERNS,
  formatTaskStateResponse,
};

export default {
  isTaskStateQuery,
  executeTaskStateQuery,
  getTaskStateQueryDebugInfo,
};
