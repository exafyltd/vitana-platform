/**
 * VTID-01161: MCP Task Discovery Contract (OASIS-Only Pending Tasks)
 *
 * HARD GOVERNANCE:
 * 1. OASIS is the ONLY source of truth for tasks
 * 2. MCP MUST NOT infer pending work from repository files
 * 3. MCP MUST NOT create/update tasks - READ-ONLY
 * 4. Tasks must be traceable to OASIS records
 * 5. Legacy DEV-* items must be listed as ignored
 */

import { gatewayClient, OasisTask } from '../lib/gateway-client.js';

// ============================================================================
// VTID-01161 Section 2: Definitions
// ============================================================================

// 2.1 Canonical Pending Status Set
const PENDING_STATUSES = ['scheduled', 'allocated', 'in_progress'] as const;

// 2.2 Terminal / Non-Pending statuses
const TERMINAL_STATUSES = ['completed', 'cancelled', 'blocked', 'failed', 'deleted'] as const;

// 2.3 Accepted VTID Format: VTID-\d{4,5}
const VTID_PATTERN = /^VTID-\d{4,5}$/;

// Hard reject patterns (legacy formats)
const LEGACY_PATTERNS = [
  /^DEV-/,
  /^ADM-/,
  /^AICOR-/,
  /^OASIS-TASK-/,
];

// ============================================================================
// Types (Section 3.2 & 3.3)
// ============================================================================

export interface DiscoverTasksParams {
  tenant?: string;
  environment?: string;
  statuses?: ('scheduled' | 'allocated' | 'in_progress')[];
  limit?: number;
  include_events?: boolean;
}

export interface PendingTask {
  vtid: string;
  title: string;
  status: string;
  task_family: string;
  task_type: string | null;
  created_at: string;
  updated_at: string;
  links: {
    task: string;
    events: string;
  };
  evidence: {
    oasis_task_present: boolean;
    status_is_pending: boolean;
    vtid_format_valid: boolean;
  };
}

export interface IgnoredItem {
  id: string;
  reason: 'ignored_by_contract';
  details: string;
}

export interface DiscoverTasksResult {
  ok: boolean;
  source_of_truth: 'OASIS';
  queried: {
    tenant: string;
    environment: string;
    statuses: string[];
    limit: number;
  };
  pending: PendingTask[];
  ignored: IgnoredItem[];
  counts: {
    pending: number;
    ignored: number;
  };
  compatibility: {
    command_hub_board_expected: boolean;
    board_source_view: string;
    note: string;
  };
  error?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a VTID matches the accepted format (VTID-\d{4,5})
 */
function isValidVtidFormat(vtid: string): boolean {
  return VTID_PATTERN.test(vtid);
}

/**
 * Check if an ID matches a legacy pattern that should be ignored
 */
function isLegacyId(id: string): { isLegacy: boolean; pattern?: string } {
  for (const pattern of LEGACY_PATTERNS) {
    if (pattern.test(id)) {
      return { isLegacy: true, pattern: pattern.source };
    }
  }
  return { isLegacy: false };
}

/**
 * Extract task family from VTID (e.g., "VTID-01166" -> "VTID")
 */
function extractTaskFamily(vtid: string): string {
  const parts = vtid.split('-');
  return parts[0] || 'UNKNOWN';
}

// ============================================================================
// Main Discovery Function (Section 4)
// ============================================================================

export async function discoverTasks(
  params: DiscoverTasksParams = {}
): Promise<DiscoverTasksResult> {
  const {
    tenant = 'vitana',
    environment = 'dev_sandbox',
    statuses = ['scheduled', 'allocated', 'in_progress'],
    limit = 50,
  } = params;

  // Validate limit (must be 1-200)
  const validatedLimit = Math.min(Math.max(limit, 1), 200);

  // Validate statuses are in canonical set
  const validStatuses = statuses.filter((s) =>
    PENDING_STATUSES.includes(s as any)
  );

  const pending: PendingTask[] = [];
  const ignored: IgnoredItem[] = [];

  try {
    // Step A: Query OASIS ONLY (Section 4 - Step A)
    const oasisTasks = await gatewayClient.discoverTasks({
      tenant,
      environment,
      statuses: validStatuses,
      limit: validatedLimit,
    });

    // Step B: Filter + Validate (Section 4 - Step B)
    for (const task of oasisTasks) {
      const vtid = task.vtid;

      // Check for legacy ID patterns first
      const { isLegacy, pattern } = isLegacyId(vtid);
      if (isLegacy) {
        ignored.push({
          id: vtid,
          reason: 'ignored_by_contract',
          details: `Non-numeric VTID format (matches ${pattern}); repo artifacts are not task truth.`,
        });
        continue;
      }

      // Validate VTID format
      const vtidFormatValid = isValidVtidFormat(vtid);
      if (!vtidFormatValid) {
        ignored.push({
          id: vtid,
          reason: 'ignored_by_contract',
          details: `VTID format invalid. Expected VTID-\\d{4,5}, got: ${vtid}`,
        });
        continue;
      }

      // Validate status is in requested statuses
      const statusIsPending = validStatuses.includes(task.status as any);
      if (!statusIsPending) {
        // Skip tasks not in requested statuses (should not happen due to filter, but safety check)
        continue;
      }

      // Task passes all validation - add to pending
      pending.push({
        vtid: task.vtid,
        title: task.title || 'Pending Title',
        status: task.status,
        task_family: extractTaskFamily(task.vtid),
        task_type: task.module || null,
        created_at: task.created_at,
        updated_at: task.updated_at,
        links: {
          task: `/api/v1/oasis/tasks/${task.vtid}`,
          events: `/api/v1/oasis/events?vtid=${task.vtid}`,
        },
        evidence: {
          oasis_task_present: true,
          status_is_pending: statusIsPending,
          vtid_format_valid: vtidFormatValid,
        },
      });
    }

    // Emit OASIS event for discovery (Section 7) - do this asynchronously
    const eventPromise = gatewayClient.emitEvent(
      'VTID-01161',
      'vtid.stage.task_discovery.success',
      `Discovered ${pending.length} pending tasks`,
      {
        tenant,
        environment,
        requested_statuses: validStatuses,
        pending_count: pending.length,
        ignored_count: ignored.length,
        mismatch_detected: false,
        mismatch_details: null,
      }
    ).catch((err) => {
      // Log but don't fail the discovery on event emit failure
      console.error('[VTID-01161] Failed to emit discovery event:', err);
    });

    // Don't await the event emit - fire and forget
    void eventPromise;

    return {
      ok: true,
      source_of_truth: 'OASIS',
      queried: {
        tenant,
        environment,
        statuses: validStatuses,
        limit: validatedLimit,
      },
      pending,
      ignored,
      counts: {
        pending: pending.length,
        ignored: ignored.length,
      },
      compatibility: {
        command_hub_board_expected: true,
        board_source_view: 'commandhub_board_visible',
        note: 'Pending tasks are defined to match board visibility logic (OASIS-driven).',
      },
    };
  } catch (error) {
    // Step A failure: return ok:false and do NOT fallback to repo scanning
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Emit failure event
    void gatewayClient.emitEvent(
      'VTID-01161',
      'vtid.stage.task_discovery.failed',
      `Task discovery failed: ${errorMessage}`,
      {
        tenant,
        environment,
        requested_statuses: validStatuses,
        pending_count: 0,
        ignored_count: 0,
        error: errorMessage,
      }
    ).catch(() => {});

    return {
      ok: false,
      source_of_truth: 'OASIS',
      queried: {
        tenant,
        environment,
        statuses: validStatuses,
        limit: validatedLimit,
      },
      pending: [],
      ignored: [],
      counts: {
        pending: 0,
        ignored: 0,
      },
      compatibility: {
        command_hub_board_expected: false,
        board_source_view: 'commandhub_board_visible',
        note: 'Discovery failed - OASIS endpoint error. NO fallback to repo scanning.',
      },
      error: errorMessage,
    };
  }
}
