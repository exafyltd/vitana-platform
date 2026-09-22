/**
 * VTID-01148 / VTID-01154: Approval-queue logic, extracted from
 * routes/approvals.ts under VTID-04279.
 *
 * Why this lives in services/, not just inline in the route handlers: the
 * Operator Console's "Developer Assistant" tools
 * (dev_list_approvals/dev_approval_count/dev_approve_item/dev_reject_item
 * in services/gemini-operator.ts) previously called the gateway's OWN
 * /api/v1/approvals routes over HTTP using SUPABASE_SERVICE_ROLE as a
 * bearer token — a real Supabase DB credential, not a user JWT.
 * routes/approvals.ts now requires a real, verified exafy_admin session
 * (requireAdminAuth, added by VTID-04279 to close the missing_auth finding
 * on this router — it previously had NO auth at all), which correctly
 * rejects that service-role "bearer": the signature verifies (it's signed
 * with the same JWT secret) but the token carries no app_metadata.
 * exafy_admin claim, so requireExafyAdmin would 403 it.
 *
 * Rather than invent a way to forward a real per-request JWT through
 * gemini-operator.ts's args/threadId-only tool dispatcher (which doesn't
 * carry one), the four functions below are the exact same logic
 * routes/approvals.ts's handlers used to run inline, callable in-process —
 * no HTTP hop, no bearer token needed for an in-process call. Every
 * function returns the exact {status, body} shape an Express handler would
 * send; routes/approvals.ts's GET /count, GET /pending, POST
 * /:approval_id/approve and POST /:approval_id/reject are now thin
 * wrappers around these.
 */
import { emitOasisEvent } from './oasis-event-service';
import { createHash } from 'crypto';

// ==================== Types ====================

export interface ApprovalItem {
  approval_id: string;
  vtid: string;
  title: string;
  layer: string | null;
  module: string | null;
  head_branch: string | null;
  pr_number: number | null;
  checks_status: 'pass' | 'fail' | 'pending' | 'unknown';
  governance_status: 'pass' | 'fail' | 'pending' | 'unknown';
  created_at: string;
  updated_at: string;
}

interface VtidLedgerRow {
  id: string;
  vtid: string;
  task_family: string;
  task_type: string;
  description: string;
  status: string;
  assigned_to: string | null;
  tenant: string;
  metadata: Record<string, unknown> | null;
  parent_vtid: string | null;
  created_at: string;
  updated_at: string;
  last_event_id: string | null;
  last_event_at: string | null;
  service: string | null;
  environment: string | null;
  layer: string | null;
  module: string | null;
  title: string | null;
  summary: string | null;
}

interface OasisEventRow {
  id: string;
  created_at: string;
  vtid: string;
  topic: string;
  status: string;
  message: string;
  metadata: {
    pr_number?: number;
    pr_url?: string;
    head_branch?: string;
    head?: string;
    base?: string;
    decision?: string;
    [key: string]: unknown;
  } | null;
}

// ==================== Helper Functions ====================

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !svcKey) {
    throw new Error('Supabase not configured');
  }
  return { supabaseUrl, svcKey };
}

/**
 * Generate deterministic approval_id from VTID
 * Format: appr_<vtid>_<hash6>
 */
function generateApprovalId(vtid: string): string {
  const hash = createHash('sha256').update(vtid).digest('hex').slice(0, 6);
  return `appr_${vtid}_${hash}`;
}

/**
 * VTID format validation: must match ^VTID-\d{4,5}$
 */
function isValidVtidFormat(vtid: string): boolean {
  return /^VTID-\d{4,5}$/.test(vtid);
}

/**
 * Check if a task is terminal based on status
 * Terminal statuses: completed, failed, cancelled, merged
 */
function isTerminalStatus(status: string): boolean {
  const terminalStatuses = ['completed', 'failed', 'cancelled', 'merged', 'deployed', 'done'];
  return terminalStatuses.includes(status.toLowerCase());
}

/**
 * Fetch VTIDs from ledger that are approval-eligible
 * Rules:
 * - VTID must match ^VTID-\d{4,5}$ format
 * - Status must not be terminal
 * - Must not be DEV-*, ADM-*, AICOR-* (legacy identifiers)
 */
async function fetchApprovalEligibleVtids(
  supabaseUrl: string,
  svcKey: string,
  limit: number
): Promise<VtidLedgerRow[]> {
  // Query vtid_ledger for non-terminal tasks
  // Filtering by VTID pattern in PostgreSQL: vtid ~ '^VTID-[0-9]{4,5}$'
  const queryUrl = `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.VTID-*&order=created_at.desc&limit=${limit}`;

  const response = await fetch(queryUrl, {
    headers: {
      apikey: svcKey,
      Authorization: `Bearer ${svcKey}`,
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[VTID-01148] vtid_ledger query failed: ${response.status} - ${errText}`);
    throw new Error(`Database query failed: ${response.status}`);
  }

  const rows = (await response.json()) as VtidLedgerRow[];

  // Filter in memory for exact VTID format and non-terminal status
  return rows.filter((row) => {
    // Must be valid VTID format
    if (!isValidVtidFormat(row.vtid)) return false;
    // Must not be terminal
    if (isTerminalStatus(row.status)) return false;
    return true;
  });
}

/**
 * Fetch PR/branch info from OASIS events for given VTIDs
 * Looks for cicd.github.create_pr.succeeded and cicd.github.find_pr.succeeded events
 */
async function fetchPrInfoForVtids(
  supabaseUrl: string,
  svcKey: string,
  vtids: string[]
): Promise<Map<string, { pr_number: number | null; head_branch: string | null; governance_passed: boolean }>> {
  if (vtids.length === 0) return new Map();

  // Query oasis_events for PR-related events
  const vtidFilter = vtids.map((v) => `"${v}"`).join(',');
  const topics = [
    'cicd.github.create_pr.succeeded',
    'cicd.github.find_pr.succeeded',
    'cicd.github.create_pr.skipped_existing',
    'cicd.github.safe_merge.evaluated',
    'cicd.github.safe_merge.approved',
  ];
  const topicFilter = topics.map((t) => `topic.eq.${t}`).join(',');

  const queryUrl = `${supabaseUrl}/rest/v1/oasis_events?vtid=in.(${vtidFilter})&or=(${topicFilter})&order=created_at.desc&limit=500`;

  const response = await fetch(queryUrl, {
    headers: {
      apikey: svcKey,
      Authorization: `Bearer ${svcKey}`,
    },
  });

  if (!response.ok) {
    console.warn(`[VTID-01148] oasis_events query failed: ${response.status}`);
    return new Map();
  }

  const events = (await response.json()) as OasisEventRow[];
  const prInfo = new Map<string, { pr_number: number | null; head_branch: string | null; governance_passed: boolean }>();

  // Process events to extract PR info (most recent first)
  for (const event of events) {
    if (!prInfo.has(event.vtid)) {
      prInfo.set(event.vtid, { pr_number: null, head_branch: null, governance_passed: false });
    }

    const info = prInfo.get(event.vtid)!;
    const metadata = event.metadata || {};

    // Extract PR number and branch from PR creation events
    if (
      event.topic === 'cicd.github.create_pr.succeeded' ||
      event.topic === 'cicd.github.find_pr.succeeded' ||
      event.topic === 'cicd.github.create_pr.skipped_existing'
    ) {
      if (metadata.pr_number && info.pr_number === null) {
        info.pr_number = metadata.pr_number as number;
      }
      if ((metadata.head_branch || metadata.head) && info.head_branch === null) {
        info.head_branch = (metadata.head_branch || metadata.head) as string;
      }
    }

    // Check governance status from evaluation events
    if (event.topic === 'cicd.github.safe_merge.evaluated' || event.topic === 'cicd.github.safe_merge.approved') {
      if (metadata.decision === 'approved' || event.topic === 'cicd.github.safe_merge.approved') {
        info.governance_passed = true;
      }
    }
  }

  return prInfo;
}

/**
 * Fetch CI check status for PRs
 * Since we don't have direct GitHub access here, we derive from OASIS events or return 'unknown'
 */
async function fetchChecksStatus(
  supabaseUrl: string,
  svcKey: string,
  vtids: string[]
): Promise<Map<string, 'pass' | 'fail' | 'pending' | 'unknown'>> {
  if (vtids.length === 0) return new Map();

  // Look for safe_merge events that indicate CI status
  const vtidFilter = vtids.map((v) => `"${v}"`).join(',');
  const queryUrl = `${supabaseUrl}/rest/v1/oasis_events?vtid=in.(${vtidFilter})&topic=like.cicd.github.safe_merge.*&order=created_at.desc&limit=200`;

  const response = await fetch(queryUrl, {
    headers: {
      apikey: svcKey,
      Authorization: `Bearer ${svcKey}`,
    },
  });

  const checksStatus = new Map<string, 'pass' | 'fail' | 'pending' | 'unknown'>();

  if (!response.ok) {
    console.warn(`[VTID-01148] checks status query failed: ${response.status}`);
    return checksStatus;
  }

  const events = (await response.json()) as OasisEventRow[];

  for (const event of events) {
    if (checksStatus.has(event.vtid)) continue;

    if (event.topic === 'cicd.github.safe_merge.executed') {
      checksStatus.set(event.vtid, 'pass');
    } else if (event.topic === 'cicd.github.safe_merge.approved') {
      checksStatus.set(event.vtid, 'pass');
    } else if (event.topic === 'cicd.github.safe_merge.blocked') {
      const metadata = event.metadata || {};
      if (metadata.reason === 'checks_failed') {
        checksStatus.set(event.vtid, 'fail');
      }
    }
  }

  return checksStatus;
}

/**
 * Build ApprovalItem from VTID ledger row and enrichment data
 */
function buildApprovalItem(
  row: VtidLedgerRow,
  prInfo: { pr_number: number | null; head_branch: string | null; governance_passed: boolean } | undefined,
  checksStatus: 'pass' | 'fail' | 'pending' | 'unknown'
): ApprovalItem {
  const info = prInfo || { pr_number: null, head_branch: null, governance_passed: false };

  return {
    approval_id: generateApprovalId(row.vtid),
    vtid: row.vtid,
    title: row.title || row.description || row.vtid,
    layer: row.layer,
    module: row.module,
    head_branch: info.head_branch,
    pr_number: info.pr_number,
    checks_status: checksStatus,
    governance_status: info.governance_passed ? 'pass' : 'pending',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Emit approval decision event to OASIS
 */
export async function emitApprovalDecision(
  vtid: string,
  approvalId: string,
  decision: 'approved' | 'rejected',
  details: Record<string, unknown>,
  decidedBy?: string | null
) {
  return emitOasisEvent({
    vtid,
    type: decision === 'approved' ? 'cicd.approval.approved' : 'cicd.approval.denied',
    source: 'approvals-api',
    status: decision === 'approved' ? 'success' : 'warning',
    message: `Approval ${decision} for ${vtid}`,
    payload: {
      approval_id: approvalId,
      decision,
      requested_by: 'ceo_ui',
      // VTID-04279: the verified exafy_admin identity that actually decided
      // this — the caller's own req.identity.user_id for an HTTP request,
      // or the resolved Operator Console thread identity for an in-process
      // call — never a client-suppliable value.
      decided_by: decidedBy ?? 'unknown',
      ...details,
    },
  });
}

// ==================== Public API ====================

/**
 * GET /count logic: the count of pending approval items.
 */
export async function getPendingApprovalCount(): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Fetch approval-eligible VTIDs (with high limit to get accurate count)
    const eligibleVtids = await fetchApprovalEligibleVtids(supabaseUrl, svcKey, 500);

    // Get PR info to filter only those with branch/PR references
    const prInfo = await fetchPrInfoForVtids(
      supabaseUrl,
      svcKey,
      eligibleVtids.map((r) => r.vtid)
    );

    // Count only VTIDs that have PR/branch info (approval-ready)
    let pendingCount = 0;
    for (const row of eligibleVtids) {
      const info = prInfo.get(row.vtid);
      // Must have head_branch or pr_number to be approval-ready
      if (info && (info.head_branch || info.pr_number)) {
        pendingCount++;
      }
    }

    console.log(`[VTID-01148] /count: ${pendingCount} pending approvals`);

    return { status: 200, body: { ok: true, pending_count: pendingCount } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01148] /count error: ${errorMessage}`);
    return { status: 500, body: { ok: false, error: errorMessage } };
  }
}

/**
 * GET /pending logic: the list of pending approval items.
 */
export async function getPendingApprovals(limit: number): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Fetch approval-eligible VTIDs
    const eligibleVtids = await fetchApprovalEligibleVtids(supabaseUrl, svcKey, 200);

    if (eligibleVtids.length === 0) {
      return { status: 200, body: { ok: true, items: [] } };
    }

    // Get PR info for all VTIDs
    const vtidList = eligibleVtids.map((r) => r.vtid);
    const prInfo = await fetchPrInfoForVtids(supabaseUrl, svcKey, vtidList);
    const checksStatus = await fetchChecksStatus(supabaseUrl, svcKey, vtidList);

    // Build approval items for VTIDs that have PR/branch references
    const items: ApprovalItem[] = [];
    for (const row of eligibleVtids) {
      const info = prInfo.get(row.vtid);

      // Must have head_branch or pr_number to be approval-ready
      if (info && (info.head_branch || info.pr_number)) {
        const checks = checksStatus.get(row.vtid) || 'unknown';
        items.push(buildApprovalItem(row, info, checks));
      }

      // Stop once we have enough items
      if (items.length >= limit) break;
    }

    console.log(`[VTID-01148] /pending: returning ${items.length} items (limit=${limit})`);

    return { status: 200, body: { ok: true, items } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01148] /pending error: ${errorMessage}`);
    return { status: 500, body: { ok: false, error: errorMessage, items: [] } };
  }
}

/**
 * POST /:approval_id/approve logic: triggers safe merge for the approval
 * item, via the existing autonomous-pr-merge endpoint.
 */
export async function approveApprovalById(
  approvalId: string,
  decidedBy: string | null
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Parse approval_id to extract VTID
    // Format: appr_VTID-XXXXX_hash6
    const vtidMatch = approvalId.match(/appr_(VTID-\d{4,5})_/);
    if (!vtidMatch) {
      return { status: 400, body: { ok: false, error: 'Invalid approval_id format' } };
    }

    const vtid = vtidMatch[1];

    // Verify the VTID exists and is approval-eligible
    const vtidQueryUrl = `${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}&limit=1`;
    const vtidResponse = await fetch(vtidQueryUrl, {
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    });

    if (!vtidResponse.ok) {
      return { status: 500, body: { ok: false, error: 'Failed to fetch VTID from ledger' } };
    }

    const vtidRows = (await vtidResponse.json()) as VtidLedgerRow[];
    if (vtidRows.length === 0) {
      return { status: 404, body: { ok: false, error: `VTID ${vtid} not found in ledger` } };
    }

    const vtidRow = vtidRows[0];

    // Check if already terminal
    if (isTerminalStatus(vtidRow.status)) {
      return {
        status: 400,
        body: { ok: false, error: `VTID ${vtid} is already in terminal status: ${vtidRow.status}` },
      };
    }

    // Get PR info
    const prInfo = await fetchPrInfoForVtids(supabaseUrl, svcKey, [vtid]);
    const info = prInfo.get(vtid);

    if (!info || !info.head_branch) {
      return {
        status: 400,
        body: { ok: false, error: `No branch/PR info found for ${vtid}. Cannot approve without PR reference.` },
      };
    }

    // Call existing autonomous-pr-merge endpoint
    const gatewayUrl = process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 8080}`;
    const mergePayload = {
      vtid,
      head_branch: info.head_branch,
      base_branch: 'main',
      title: vtidRow.title || vtidRow.description || vtid,
      body: `Approved via Approvals API for ${vtid}`,
      merge_method: 'squash',
      automerge: true,
    };

    console.log(`[VTID-01148] Approving ${vtid}: calling autonomous-pr-merge`);

    const mergeResponse = await fetch(`${gatewayUrl}/api/v1/github/autonomous-pr-merge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mergePayload),
    });

    const mergeResult = (await mergeResponse.json()) as {
      ok: boolean;
      merged?: boolean;
      error?: string;
      [key: string]: unknown;
    };

    // Emit approval event to OASIS
    await emitApprovalDecision(
      vtid,
      approvalId,
      'approved',
      {
        head_branch: info.head_branch,
        pr_number: info.pr_number,
        merge_result: mergeResult,
      },
      decidedBy
    );

    if (mergeResult.ok) {
      console.log(`[VTID-01148] Approval successful for ${vtid}: merged=${mergeResult.merged}`);
      return { status: 200, body: { ok: true, result: mergeResult } };
    } else {
      console.error(`[VTID-01148] Approval merge failed for ${vtid}: ${mergeResult.error}`);
      return {
        status: mergeResponse.status,
        body: { ok: false, error: mergeResult.error || 'Merge failed', result: mergeResult },
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01148] /approve error for ${approvalId}: ${errorMessage}`);
    return { status: 500, body: { ok: false, error: errorMessage } };
  }
}

/**
 * POST /:approval_id/reject logic: records rejection for the approval item.
 */
export async function rejectApprovalById(
  approvalId: string,
  reason: string | undefined,
  decidedBy: string | null
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Parse approval_id to extract VTID
    const vtidMatch = approvalId.match(/appr_(VTID-\d{4,5})_/);
    if (!vtidMatch) {
      return { status: 400, body: { ok: false, error: 'Invalid approval_id format' } };
    }

    const vtid = vtidMatch[1];

    // Verify the VTID exists
    const vtidQueryUrl = `${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}&limit=1`;
    const vtidResponse = await fetch(vtidQueryUrl, {
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    });

    if (!vtidResponse.ok) {
      return { status: 500, body: { ok: false, error: 'Failed to fetch VTID from ledger' } };
    }

    const vtidRows = (await vtidResponse.json()) as VtidLedgerRow[];
    if (vtidRows.length === 0) {
      return { status: 404, body: { ok: false, error: `VTID ${vtid} not found in ledger` } };
    }

    // Emit rejection event to OASIS
    await emitApprovalDecision(vtid, approvalId, 'rejected', { reason: reason || 'No reason provided' }, decidedBy);

    console.log(`[VTID-01148] Rejection recorded for ${vtid}: ${reason || 'No reason provided'}`);

    return { status: 200, body: { ok: true } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01148] /reject error for ${approvalId}: ${errorMessage}`);
    return { status: 500, body: { ok: false, error: errorMessage } };
  }
}
