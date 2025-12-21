/**
 * VTID-0509 + VTID-0531 + VTID-0532 + VTID-0533 + VTID-01004: Operator Service
 * Business logic for operator console - aggregates data from OASIS/CICD
 *
 * VTID-0531: Added OASIS integration for chat messages with thread/vtid support
 * VTID-0532: Added task extraction, VTID/Task creation, and planner handoff
 * VTID-0533: Added Planner execution pipeline (plan submission, worker/validator events)
 * VTID-01004: Event classification to prevent telemetry from polluting OASIS
 */

import fetch from 'node-fetch';
import { randomUUID } from 'crypto';

// ==================== VTID-01004: Event Classification ====================
// Event categories for OASIS ingestion control
// Only operational, decision, and governance events enter OASIS
// Telemetry events are blocked at ingestion level

export type EventClassification = 'telemetry' | 'operational' | 'decision' | 'governance';

/**
 * VTID-01004: Telemetry event patterns that must NOT enter OASIS
 * These are periodic keep-alive, heartbeat, and diagnostic events
 */
const TELEMETRY_PATTERNS: RegExp[] = [
  /^operator\.heartbeat\./,       // operator.heartbeat.started, operator.heartbeat.snapshot, operator.heartbeat.stopped
  /^operator\.heartbeat$/,        // operator.heartbeat (base)
  /^gateway\.health\.ping$/,      // health check pings
  /^system\.keepalive$/,          // keep-alive events
  /^diagnostics\./,               // diagnostic events
];

/**
 * VTID-01004: Classify an event type
 * Returns 'telemetry' for heartbeat/diagnostic events that should NOT enter OASIS
 */
export function classifyEventType(eventType: string): EventClassification {
  // Check if event matches any telemetry pattern
  for (const pattern of TELEMETRY_PATTERNS) {
    if (pattern.test(eventType)) {
      return 'telemetry';
    }
  }

  // Governance events
  if (eventType.startsWith('governance.')) {
    return 'governance';
  }

  // Decision events (approvals, validations, blocking decisions)
  if (eventType.includes('.approved') ||
      eventType.includes('.rejected') ||
      eventType.includes('.blocked') ||
      eventType.includes('.decision') ||
      eventType.startsWith('autopilot.validation.')) {
    return 'decision';
  }

  // Everything else is operational
  return 'operational';
}

/**
 * VTID-01004: Check if an event type is allowed to enter OASIS
 * Only operational, decision, and governance events are allowed
 * Telemetry events are blocked
 */
export function isOasisAllowed(eventType: string): boolean {
  const classification = classifyEventType(eventType);
  return classification !== 'telemetry';
}
import {
  OperatorChatRole,
  OperatorChatMode,
  ThreadHistoryMessage,
  OperatorChatEventPayload,
  isValidVtidFormat
} from '../types/operator-chat';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Types
export interface OperatorEventInput {
  vtid: string;
  type: string;
  status: 'info' | 'warning' | 'error' | 'success';
  message: string;
  payload?: Record<string, any>;
}

export interface TasksSummary {
  total: number;
  by_status: {
    scheduled: number;
    in_progress: number;
    completed: number;
    pending: number;
    blocked: number;
    cancelled: number;
  };
}

export interface RecentEvent {
  type: string;
  created_at: string;
  summary: string;
}

export interface CicdHealth {
  status: string;
  last_run: string | null;
}

export interface HistoryEvent {
  id: string;
  type: string;
  status: string;
  vtid: string | null;
  created_at: string;
  summary: string;
}

/**
 * Ingest an operator event to OASIS via /api/v1/events/ingest
 * VTID-01004: Blocks telemetry events from entering OASIS
 */
export async function ingestOperatorEvent(input: OperatorEventInput): Promise<void> {
  // VTID-01004: Check event classification before ingestion
  const classification = classifyEventType(input.type);

  if (classification === 'telemetry') {
    // VTID-01004: Telemetry events are blocked from OASIS
    // Log to console for diagnostics visibility only
    console.log(`[Operator Service] [TELEMETRY] ${input.type} - ${input.message} (blocked from OASIS)`);
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[Operator Service] Supabase not configured, skipping event ingest');
    return;
  }

  try {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    const payload = {
      id: eventId,
      created_at: timestamp,
      vtid: input.vtid,
      topic: input.type,
      service: 'operator-console',
      role: 'OPERATOR',
      model: 'operator-service',
      status: input.status,
      message: input.message,
      link: null,
      metadata: {
        ...input.payload,
        // VTID-01004: Include classification for audit trail
        event_classification: classification
      }
    };

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[Operator Service] Event ingest failed: ${resp.status} - ${text}`);
    } else {
      console.log(`[Operator Service] Event ingested: ${input.type} [${classification}]`);
    }
  } catch (error: any) {
    console.warn(`[Operator Service] Event ingest error: ${error.message}`);
  }
}

/**
 * Get tasks summary from OASIS vtid_ledger
 */
export async function getTasksSummary(): Promise<TasksSummary> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[Operator Service] Supabase not configured, returning empty summary');
    return {
      total: 0,
      by_status: { scheduled: 0, in_progress: 0, completed: 0, pending: 0, blocked: 0, cancelled: 0 }
    };
  }

  try {
    // Fetch all tasks to count by status
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger?select=status&limit=500`, {
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      }
    });

    if (!resp.ok) {
      console.warn(`[Operator Service] Tasks query failed: ${resp.status}`);
      return {
        total: 0,
        by_status: { scheduled: 0, in_progress: 0, completed: 0, pending: 0, blocked: 0, cancelled: 0 }
      };
    }

    const tasks = await resp.json() as Array<{ status: string }>;

    // Count by status
    const by_status = {
      scheduled: 0,
      in_progress: 0,
      completed: 0,
      pending: 0,
      blocked: 0,
      cancelled: 0
    };

    for (const task of tasks) {
      const status = task.status?.toLowerCase() || 'pending';
      if (status in by_status) {
        by_status[status as keyof typeof by_status]++;
      } else {
        // Map unknown statuses
        if (status === 'open' || status === 'todo') by_status.scheduled++;
        else if (status === 'active' || status === 'running') by_status.in_progress++;
        else if (status === 'done' || status === 'closed' || status === 'success') by_status.completed++;
        else if (status === 'failed') by_status.cancelled++;
        else by_status.pending++;
      }
    }

    return {
      total: tasks.length,
      by_status
    };

  } catch (error: any) {
    console.warn(`[Operator Service] Tasks summary error: ${error.message}`);
    return {
      total: 0,
      by_status: { scheduled: 0, in_progress: 0, completed: 0, pending: 0, blocked: 0, cancelled: 0 }
    };
  }
}

/**
 * Get recent events from OASIS
 */
export async function getRecentEvents(limit: number = 10): Promise<RecentEvent[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[Operator Service] Supabase not configured, returning empty events');
    return [];
  }

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?select=topic,created_at,message&order=created_at.desc&limit=${limit}`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!resp.ok) {
      console.warn(`[Operator Service] Events query failed: ${resp.status}`);
      return [];
    }

    const events = await resp.json() as Array<{ topic: string; created_at: string; message: string }>;

    return events.map(e => ({
      type: e.topic || 'unknown',
      created_at: e.created_at,
      summary: e.message?.substring(0, 100) || 'No message'
    }));

  } catch (error: any) {
    console.warn(`[Operator Service] Recent events error: ${error.message}`);
    return [];
  }
}

/**
 * Get CICD health status
 */
export async function getCicdHealth(): Promise<CicdHealth> {
  // For now, return a healthy stub
  // Future: Query actual CICD service
  return {
    status: 'ok',
    last_run: new Date().toISOString()
  };
}

/**
 * Get operator history - filtered events from OASIS
 * VTID-01004: Excludes telemetry events (heartbeat, health pings) from history
 * Filters: operator.chat.*, operator.upload, deploy.*, cicd.* (NOT operator.heartbeat.*)
 */
export async function getOperatorHistory(limit: number = 50): Promise<HistoryEvent[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[Operator Service] Supabase not configured, returning empty history');
    return [];
  }

  try {
    // VTID-01004: Query events with topic filter - excludes heartbeat/telemetry
    // We fetch operator.% events but filter out heartbeat in memory
    const topicPatterns = [
      'topic.like.operator.%',
      'topic.like.deploy.%',
      'topic.like.cicd.%',
      'topic.like.gateway.health.%'
    ].join(',');

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?select=id,topic,status,vtid,created_at,message&or=(${topicPatterns})&order=created_at.desc&limit=${limit * 2}`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!resp.ok) {
      // Fallback: get all recent events if filter fails
      console.warn('[Operator Service] Filtered history query failed, falling back to unfiltered');
      const fallbackResp = await fetch(
        `${SUPABASE_URL}/rest/v1/oasis_events?select=id,topic,status,vtid,created_at,message&order=created_at.desc&limit=${limit * 2}`,
        {
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
          }
        }
      );

      if (!fallbackResp.ok) {
        console.warn(`[Operator Service] History fallback query failed: ${fallbackResp.status}`);
        return [];
      }

      const allEvents = await fallbackResp.json() as any[];

      // VTID-01004: Filter in memory - include operational types, exclude telemetry
      const operatorTypes = ['operator', 'deploy', 'cicd', 'gateway.health'];
      const filtered = allEvents
        .filter(e => {
          const topic = e.topic || '';
          // Must match an operator type AND not be telemetry
          return operatorTypes.some(t => topic.startsWith(t)) && isOasisAllowed(topic);
        })
        .slice(0, limit);

      return filtered.map(e => ({
        id: e.id,
        type: e.topic || 'unknown',
        status: e.status || 'info',
        vtid: e.vtid || null,
        created_at: e.created_at,
        summary: e.message?.substring(0, 150) || 'No message'
      }));
    }

    const events = await resp.json() as any[];

    // VTID-01004: Filter out any telemetry events (legacy heartbeats that may exist)
    const filtered = events
      .filter(e => isOasisAllowed(e.topic || ''))
      .slice(0, limit);

    return filtered.map(e => ({
      id: e.id,
      type: e.topic || 'unknown',
      status: e.status || 'info',
      vtid: e.vtid || null,
      created_at: e.created_at,
      summary: e.message?.substring(0, 150) || 'No message'
    }));

  } catch (error: any) {
    console.warn(`[Operator Service] History error: ${error.message}`);
    return [];
  }
}

// ==================== VTID-0531: Chat OASIS Integration ====================

/**
 * Ingest a chat message event to OASIS with unified event type
 * @returns The event ID if successful, undefined otherwise
 */
export async function ingestChatMessageEvent(input: {
  threadId: string;
  vtid?: string;
  role: OperatorChatRole;
  mode: OperatorChatMode;
  message: string;
  attachmentsCount?: number;
  metadata?: Record<string, unknown>;
}): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[Operator Service] Supabase not configured, skipping chat event ingest');
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    // Build payload according to VTID-0531 spec
    const eventPayload: OperatorChatEventPayload = {
      threadId: input.threadId,
      role: input.role,
      mode: input.mode,
    };

    // Only include vtid in payload if provided
    if (input.vtid) {
      eventPayload.vtid = input.vtid;
    }

    if (input.attachmentsCount !== undefined && input.attachmentsCount > 0) {
      eventPayload.attachments_count = input.attachmentsCount;
    }

    if (input.metadata) {
      eventPayload.metadata = input.metadata;
    }

    const dbPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: input.vtid || null,  // Set vtid column if provided
      topic: 'operator.chat.message',  // Unified event type per VTID-0531
      service: 'operator-console',
      role: 'OPERATOR',
      model: 'operator-service',
      status: 'info',
      message: input.message,
      link: null,
      metadata: eventPayload
    };

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(dbPayload)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[Operator Service] Chat event ingest failed: ${resp.status} - ${text}`);
      return { ok: false, error: `Event ingest failed: ${resp.status}` };
    }

    console.log(`[Operator Service] Chat event ingested: ${eventId} (thread: ${input.threadId}, role: ${input.role})`);
    return { ok: true, eventId };
  } catch (error: any) {
    console.warn(`[Operator Service] Chat event ingest error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * Validate a VTID by checking if it exists in the vtid_ledger
 * @returns true if valid, false otherwise (logs warning but does not fail)
 */
export async function validateVtidExists(vtid: string): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[Operator Service] Supabase not configured, skipping VTID validation');
    return false;
  }

  // First check format
  if (!isValidVtidFormat(vtid)) {
    console.warn(`[Operator Service] Invalid VTID format: ${vtid}`);
    return false;
  }

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=vtid&limit=1`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!resp.ok) {
      console.warn(`[Operator Service] VTID validation query failed: ${resp.status}`);
      return false;
    }

    const data = await resp.json() as any[];
    const exists = data.length > 0;

    if (!exists) {
      console.warn(`[Operator Service] VTID not found in ledger: ${vtid}`);
    }

    return exists;
  } catch (error: any) {
    console.warn(`[Operator Service] VTID validation error: ${error.message}`);
    return false;
  }
}

/**
 * Get chat thread history from OASIS events
 * Queries events with type='operator.chat.message' and matching threadId in payload
 */
export async function getChatThreadHistory(threadId: string): Promise<ThreadHistoryMessage[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[Operator Service] Supabase not configured, returning empty thread history');
    return [];
  }

  try {
    // Query events with operator.chat.message type
    // Filter by threadId in metadata (payload) using PostgREST JSON filtering
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?topic=eq.operator.chat.message&metadata->>threadId=eq.${encodeURIComponent(threadId)}&select=id,created_at,vtid,message,metadata&order=created_at.asc&limit=100`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[Operator Service] Thread history query failed: ${resp.status} - ${text}`);
      return [];
    }

    const events = await resp.json() as Array<{
      id: string;
      created_at: string;
      vtid: string | null;
      message: string;
      metadata: OperatorChatEventPayload;
    }>;

    console.log(`[Operator Service] Thread history: found ${events.length} messages for thread ${threadId}`);

    return events.map(e => ({
      id: e.id,
      threadId: e.metadata?.threadId || threadId,
      vtid: e.metadata?.vtid || e.vtid || undefined,
      role: (e.metadata?.role || 'operator') as OperatorChatRole,
      mode: (e.metadata?.mode || 'chat') as OperatorChatMode,
      message: e.message,
      createdAt: e.created_at
    }));
  } catch (error: any) {
    console.warn(`[Operator Service] Thread history error: ${error.message}`);
    return [];
  }
}

// ==================== VTID-0532: Task Extractor + Planner Handoff ====================
// ==================== VTID-0542: Global VTID Allocator Integration ====================

/**
 * Task creation result
 */
export interface CreatedTask {
  vtid: string;
  title: string;
  mode: 'plan-only';
}

/**
 * VTID-0542: Allocator response type
 */
interface AllocatorResponse {
  ok: boolean;
  vtid?: string;
  num?: number;
  id?: string;
  error?: string;
  message?: string;
}

/**
 * VTID-0542: Allocate a VTID using the global allocator API
 * Calls POST /api/v1/vtid/allocate internally via the gateway
 *
 * @param source - Source of the allocation (e.g., 'operator-chat', 'command-hub', 'manual')
 * @param layer - Task layer (e.g., 'DEV', 'ADM', 'GOVRN')
 * @param module - Task module (e.g., 'COMHU', 'TASK')
 * @returns Allocator response with VTID if successful
 */
export async function allocateVtid(
  source: string,
  layer: string = 'DEV',
  module: string = 'TASK'
): Promise<AllocatorResponse> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0542] Supabase not configured for allocator');
    return { ok: false, error: 'not_configured', message: 'Supabase not configured' };
  }

  try {
    // Call the allocate_global_vtid RPC directly
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/allocate_global_vtid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      },
      body: JSON.stringify({
        p_source: source,
        p_layer: layer,
        p_module: module
      })
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.warn(`[VTID-0542] Allocator RPC failed: ${resp.status} - ${errorText}`);

      // Check if it's a "function not found" error (allocator not yet deployed)
      if (resp.status === 404 || errorText.includes('function') || errorText.includes('does not exist')) {
        return {
          ok: false,
          error: 'allocator_not_deployed',
          message: 'Global allocator function not yet deployed. Run migration 20251216_vtid_0542_global_allocator.sql'
        };
      }

      return { ok: false, error: 'allocation_failed', message: errorText };
    }

    const result = await resp.json() as Array<{ vtid: string; num: number; id: string }>;

    if (!result || result.length === 0) {
      console.warn('[VTID-0542] Allocator returned empty result');
      return { ok: false, error: 'allocation_empty', message: 'No result from allocator' };
    }

    const allocated = result[0];
    console.log(`[VTID-0542] Allocated VTID: ${allocated.vtid} (num=${allocated.num}, source=${source})`);

    return {
      ok: true,
      vtid: allocated.vtid,
      num: allocated.num,
      id: allocated.id
    };
  } catch (error: any) {
    console.warn(`[VTID-0542] Allocator error: ${error.message}`);
    return { ok: false, error: 'internal_error', message: error.message };
  }
}

/**
 * Task spec event metadata payload
 */
export interface TaskSpecEventPayload {
  vtid: string;
  sourceThreadId: string;
  sourceMessageId?: string;
  rawDescription: string;
  mode: 'plan-only';
  createdBy: 'operator';
  module: string;
  acceptanceCriteria: string[];
  constraints: string[];
}

/**
 * Extract title from raw description
 * Uses first sentence or first ~100-120 characters
 */
function extractTitle(rawDescription: string): string {
  if (!rawDescription || rawDescription.trim().length === 0) {
    return 'Untitled Operator Task';
  }

  const trimmed = rawDescription.trim();

  // Try to get first sentence (ending with . ! or ?)
  const sentenceMatch = trimmed.match(/^[^.!?]+[.!?]/);
  if (sentenceMatch && sentenceMatch[0].length <= 120) {
    return sentenceMatch[0].trim();
  }

  // Otherwise, take first 100-120 characters at word boundary
  if (trimmed.length <= 120) {
    return trimmed;
  }

  // Find last space before 120 chars
  const truncated = trimmed.slice(0, 120);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 80) {
    return truncated.slice(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Create a VTID for an operator task
 * Uses the existing VTID generation RPC
 */
async function generateVtid(family: string, module: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0532] Supabase not configured');
    return null;
  }

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/next_vtid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      },
      body: JSON.stringify({ p_family: family, p_module: module })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0532] VTID generation failed: ${resp.status} - ${text}`);
      return null;
    }

    return (await resp.json()) as string;
  } catch (error: any) {
    console.warn(`[VTID-0532] VTID generation error: ${error.message}`);
    return null;
  }
}

/**
 * Insert a task entry into vtid_ledger
 */
async function insertTaskEntry(params: {
  vtid: string;
  layer: string;
  module: string;
  title: string;
  summary: string;
  status: string;
  metadata: Record<string, unknown>;
}): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0532] Supabase not configured');
    return false;
  }

  try {
    // Match the existing VtidLedger insert pattern from vtid.ts
    const payload = {
      id: randomUUID(),
      vtid: params.vtid,
      task_family: params.layer,
      task_module: params.module,
      layer: params.module.slice(0, 3),  // First 3 chars of module
      module: params.module,
      title: params.title,
      description_md: params.summary,
      status: params.status,
      tenant: 'vitana',
      is_test: false,
      metadata: params.metadata
    };

    // Use VtidLedger (PascalCase) to match existing vtid.ts pattern
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/VtidLedger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0532] Task insert failed: ${resp.status} - ${text}`);
      return false;
    }

    console.log(`[VTID-0532] Task entry created: ${params.vtid}`);
    return true;
  } catch (error: any) {
    console.warn(`[VTID-0532] Task insert error: ${error.message}`);
    return false;
  }
}

/**
 * Emit autopilot.task.spec.created event to OASIS
 */
export async function emitTaskSpecEvent(params: {
  vtid: string;
  title: string;
  sourceThreadId: string;
  sourceMessageId?: string;
  rawDescription: string;
  module: string;
}): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0532] Supabase not configured, skipping task spec event');
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    const metadata: TaskSpecEventPayload = {
      vtid: params.vtid,
      sourceThreadId: params.sourceThreadId,
      sourceMessageId: params.sourceMessageId,
      rawDescription: params.rawDescription,
      mode: 'plan-only',
      createdBy: 'operator',
      module: params.module,
      acceptanceCriteria: [],
      constraints: []
    };

    const dbPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: params.vtid,
      topic: 'autopilot.task.spec.created',
      service: 'operator-console',
      role: 'OPERATOR',
      model: 'task-extractor',
      status: 'info',  // Use 'info' as valid status (pending is task status, not event status)
      message: params.title,
      link: null,
      metadata
    };

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(dbPayload)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0532] Task spec event failed: ${resp.status} - ${text}`);
      return { ok: false, error: `Event emit failed: ${resp.status}` };
    }

    console.log(`[VTID-0532] Task spec event emitted: ${eventId} for ${params.vtid}`);
    return { ok: true, eventId };
  } catch (error: any) {
    console.warn(`[VTID-0532] Task spec event error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * VTID-0542: Update an allocated task shell with actual task data
 * Updates the existing row created by the allocator
 */
async function updateAllocatedTaskEntry(params: {
  vtid: string;
  title: string;
  summary: string;
  status: string;
  metadata: Record<string, unknown>;
}): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0542] Supabase not configured');
    return false;
  }

  try {
    const updatePayload = {
      title: params.title,
      description: params.summary,
      summary: params.summary,
      description_md: params.summary,
      status: params.status,
      metadata: params.metadata,
      updated_at: new Date().toISOString()
    };

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/VtidLedger?vtid=eq.${encodeURIComponent(params.vtid)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(updatePayload)
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0542] Task update failed: ${resp.status} - ${text}`);
      return false;
    }

    console.log(`[VTID-0542] Task entry updated: ${params.vtid}`);
    return true;
  } catch (error: any) {
    console.warn(`[VTID-0542] Task update error: ${error.message}`);
    return false;
  }
}

/**
 * Create VTID + Task entry + Task Spec event for an operator task request
 * VTID-0542: Now uses the global allocator for VTID generation
 * @returns CreatedTask if successful, undefined otherwise
 */
export async function createOperatorTask(params: {
  rawDescription: string;
  sourceThreadId: string;
  sourceMessageId?: string;
}): Promise<CreatedTask | undefined> {
  const { rawDescription, sourceThreadId, sourceMessageId } = params;

  // Use DEV layer and COMHU (Command Hub) module for operator tasks
  const layer = 'DEV';
  const module = 'COMHU';

  // Extract title from description
  const title = extractTitle(rawDescription);

  // VTID-0542: Use global allocator instead of legacy generateVtid
  const allocResult = await allocateVtid('operator-chat', layer, module);

  let vtid: string;

  if (allocResult.ok && allocResult.vtid) {
    // Allocator succeeded - update the shell entry with actual task data
    vtid = allocResult.vtid;
    console.log(`[VTID-0542] Using allocated VTID: ${vtid}`);

    const updated = await updateAllocatedTaskEntry({
      vtid,
      title,
      summary: rawDescription,
      status: 'pending',
      metadata: {
        source: 'operator-chat',
        threadId: sourceThreadId,
        createdVia: 'vtid-0542-allocator',
        allocatedNum: allocResult.num
      }
    });

    if (!updated) {
      console.warn(`[VTID-0542] Failed to update allocated task entry for ${vtid}`);
      // Continue anyway since the shell entry exists
    }
  } else {
    // Allocator failed - fall back to legacy method for backwards compatibility
    console.warn(`[VTID-0542] Allocator failed (${allocResult.error}), falling back to legacy generateVtid`);

    const legacyVtid = await generateVtid(layer, module);
    if (!legacyVtid) {
      console.warn('[VTID-0532] Failed to generate VTID via legacy method');
      return undefined;
    }

    vtid = legacyVtid;

    // Insert task entry via legacy method
    const inserted = await insertTaskEntry({
      vtid,
      layer,
      module,
      title,
      summary: rawDescription,
      status: 'pending',
      metadata: {
        source: 'operator-chat',
        threadId: sourceThreadId,
        createdVia: 'legacy-fallback'
      }
    });

    if (!inserted) {
      console.warn(`[VTID-0532] Failed to insert task entry for ${vtid}`);
      return undefined;
    }
  }

  // Emit task spec event
  const eventResult = await emitTaskSpecEvent({
    vtid,
    title,
    sourceThreadId,
    sourceMessageId,
    rawDescription,
    module
  });

  if (!eventResult.ok) {
    console.warn(`[VTID-0532] Task created but spec event failed: ${eventResult.error}`);
    // Task was still created, so return it
  }

  console.log(`[VTID-0542] Operator task created: ${vtid} - "${title}"`);

  return {
    vtid,
    title,
    mode: 'plan-only'
  };
}

/**
 * Pending task for planner
 */
export interface PendingPlanTask {
  vtid: string;
  title: string;
  description: string;
  module: string | null;
  mode: 'plan-only';
  createdAt: string;
  sourceThreadId?: string;
  sourceMessageId?: string;
}

/**
 * Get pending tasks for planner agents
 * Returns tasks that have autopilot.task.spec.created events
 * and are in pending/scheduled status
 */
export async function getPendingPlanTasks(): Promise<PendingPlanTask[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0532] Supabase not configured, returning empty pending tasks');
    return [];
  }

  try {
    // First, get VTIDs that have autopilot.task.spec.created events
    const eventsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?topic=eq.autopilot.task.spec.created&select=vtid,created_at,message,metadata&order=created_at.desc&limit=100`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!eventsResp.ok) {
      const text = await eventsResp.text();
      console.warn(`[VTID-0532] Events query failed: ${eventsResp.status} - ${text}`);
      return [];
    }

    const events = await eventsResp.json() as Array<{
      vtid: string;
      created_at: string;
      message: string;
      metadata: TaskSpecEventPayload;
    }>;

    if (events.length === 0) {
      console.log('[VTID-0532] No pending task spec events found');
      return [];
    }

    // Get unique VTIDs
    const vtids = [...new Set(events.map(e => e.vtid).filter(Boolean))];

    if (vtids.length === 0) {
      return [];
    }

    // Fetch task entries for these VTIDs (use VtidLedger to match insert pattern)
    const vtidList = vtids.map(v => `"${v}"`).join(',');
    const tasksResp = await fetch(
      `${SUPABASE_URL}/rest/v1/VtidLedger?vtid=in.(${vtidList})&status=in.(pending,scheduled)&select=vtid,title,description_md,module,status,created_at`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!tasksResp.ok) {
      const text = await tasksResp.text();
      console.warn(`[VTID-0532] Tasks query failed: ${tasksResp.status} - ${text}`);
      return [];
    }

    const tasks = await tasksResp.json() as Array<{
      vtid: string;
      title: string;
      description_md: string;
      module: string;
      status: string;
      created_at: string;
    }>;

    // Check if any tasks already have a plan event (autopilot.plan.created)
    // For now, skip this filter as the event type doesn't exist yet
    // TODO: Add this filter when autopilot.plan.created events are implemented

    // Build the result by joining tasks with their spec events
    const eventsByVtid = new Map(events.map(e => [e.vtid, e]));

    const pendingTasks: PendingPlanTask[] = tasks
      .filter(t => eventsByVtid.has(t.vtid))
      .map(t => {
        const event = eventsByVtid.get(t.vtid)!;
        return {
          vtid: t.vtid,
          title: t.title,
          description: t.description_md ?? t.title,
          module: t.module ?? null,
          mode: 'plan-only' as const,
          createdAt: t.created_at,
          sourceThreadId: event.metadata?.sourceThreadId,
          sourceMessageId: event.metadata?.sourceMessageId
        };
      });

    console.log(`[VTID-0532] Found ${pendingTasks.length} pending plan tasks`);
    return pendingTasks;
  } catch (error: any) {
    console.warn(`[VTID-0532] Pending plan tasks error: ${error.message}`);
    return [];
  }
}

// ==================== VTID-0533: Planner Execution Pipeline ====================

/**
 * Plan step interface
 */
export interface PlanStep {
  id: string;
  title: string;
  description: string;
  owner: 'WORKER' | 'PLANNER' | 'VALIDATOR' | 'OPERATOR';
  estimated_effort: 'XS' | 'S' | 'M' | 'L' | 'XL';
  dependencies: string[];
}

/**
 * Plan submission payload
 */
export interface PlanPayload {
  summary: string;
  steps: PlanStep[];
}

/**
 * Plan metadata
 */
export interface PlanMetadata {
  plannerModel: string;
  plannerRole: string;
  source?: string;
  notes?: string;
}

/**
 * Task status type for the execution pipeline
 */
export type AutopilotTaskStatus =
  | 'pending'
  | 'scheduled'
  | 'planned'
  | 'in-progress'
  | 'completed'
  | 'validated'
  | 'failed'
  | 'cancelled';

/**
 * Task status response
 */
export interface TaskStatusResponse {
  vtid: string;
  status: AutopilotTaskStatus;
  title?: string;
  planSteps?: number;
  validationStatus?: 'pending' | 'approved' | 'rejected';
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Work started payload
 */
export interface WorkStartedPayload {
  stepId: string;
  workerModel: string;
  notes?: string;
}

/**
 * Work completed payload
 */
export interface WorkCompletedPayload {
  stepId: string;
  status: 'success' | 'failure' | 'partial';
  outputSummary: string;
  details?: Record<string, unknown>;
}

/**
 * Validation issue
 */
export interface ValidationIssue {
  code: string;
  message: string;
}

/**
 * Validation result payload
 */
export interface ValidationResultPayload {
  status: 'approved' | 'rejected';
  issues?: ValidationIssue[];
  notes?: string;
}

/**
 * Validation metadata
 */
export interface ValidationMetadata {
  validatorModel: string;
  validatorRole: string;
}

/**
 * Update task status in VtidLedger
 */
async function updateTaskStatus(vtid: string, status: AutopilotTaskStatus, metadata?: Record<string, unknown>): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0533] Supabase not configured');
    return false;
  }

  try {
    const updatePayload: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString()
    };

    if (metadata) {
      updatePayload.metadata = metadata;
    }

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/VtidLedger?vtid=eq.${encodeURIComponent(vtid)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(updatePayload)
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0533] Task status update failed: ${resp.status} - ${text}`);
      return false;
    }

    console.log(`[VTID-0533] Task ${vtid} status updated to: ${status}`);
    return true;
  } catch (error: any) {
    console.warn(`[VTID-0533] Task status update error: ${error.message}`);
    return false;
  }
}

/**
 * Emit an autopilot event to OASIS
 */
async function emitAutopilotEvent(params: {
  vtid: string;
  topic: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  metadata: Record<string, unknown>;
}): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0533] Supabase not configured, skipping event');
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    const dbPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: params.vtid,
      topic: params.topic,
      service: 'autopilot-pipeline',
      role: 'AUTOPILOT',
      model: 'execution-pipeline',
      status: params.status,
      message: params.message,
      link: null,
      metadata: params.metadata
    };

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(dbPayload)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[VTID-0533] Event emit failed: ${resp.status} - ${text}`);
      return { ok: false, error: `Event emit failed: ${resp.status}` };
    }

    console.log(`[VTID-0533] Event emitted: ${params.topic} for ${params.vtid} (${eventId})`);
    return { ok: true, eventId };
  } catch (error: any) {
    console.warn(`[VTID-0533] Event emit error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * Check if a task exists and get its current status
 */
export async function getTaskInfo(vtid: string): Promise<{ exists: boolean; status?: string; title?: string; metadata?: Record<string, unknown> }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0533] Supabase not configured');
    return { exists: false };
  }

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/VtidLedger?vtid=eq.${encodeURIComponent(vtid)}&select=vtid,status,title,metadata&limit=1`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!resp.ok) {
      console.warn(`[VTID-0533] Task info query failed: ${resp.status}`);
      return { exists: false };
    }

    const data = await resp.json() as Array<{ vtid: string; status: string; title: string; metadata?: Record<string, unknown> }>;

    if (data.length === 0) {
      return { exists: false };
    }

    return {
      exists: true,
      status: data[0].status,
      title: data[0].title,
      metadata: data[0].metadata
    };
  } catch (error: any) {
    console.warn(`[VTID-0533] Task info error: ${error.message}`);
    return { exists: false };
  }
}

/**
 * Submit a plan for a task
 * - Validates task exists and is in pending/scheduled status
 * - Emits autopilot.plan.created event
 * - Updates task status to 'planned'
 */
export async function submitPlan(
  vtid: string,
  plan: PlanPayload,
  metadata: PlanMetadata
): Promise<{ ok: boolean; vtid?: string; status?: string; planSteps?: number; error?: string }> {
  console.log(`[VTID-0533] Submitting plan for ${vtid}`);

  // Get task info
  const taskInfo = await getTaskInfo(vtid);

  if (!taskInfo.exists) {
    return { ok: false, error: `Task ${vtid} not found` };
  }

  // Check if task is in a valid state for planning
  const validStatuses = ['pending', 'scheduled'];
  if (!validStatuses.includes(taskInfo.status || '')) {
    return { ok: false, error: `Task ${vtid} is not pending a plan (current status: ${taskInfo.status})` };
  }

  // Emit plan created event
  const eventResult = await emitAutopilotEvent({
    vtid,
    topic: 'autopilot.plan.created',
    status: 'success',
    message: plan.summary,
    metadata: {
      plan,
      plannerModel: metadata.plannerModel,
      plannerRole: metadata.plannerRole,
      source: metadata.source || 'autopilot',
      notes: metadata.notes,
      stepCount: plan.steps.length
    }
  });

  if (!eventResult.ok) {
    return { ok: false, error: `Failed to emit plan event: ${eventResult.error}` };
  }

  // Update task status to 'planned'
  const updateResult = await updateTaskStatus(vtid, 'planned', {
    ...taskInfo.metadata,
    plan,
    planEventId: eventResult.eventId,
    plannedAt: new Date().toISOString(),
    plannerModel: metadata.plannerModel
  });

  if (!updateResult) {
    console.warn(`[VTID-0533] Plan event emitted but status update failed for ${vtid}`);
  }

  console.log(`[VTID-0533] Plan submitted for ${vtid} with ${plan.steps.length} steps`);

  return {
    ok: true,
    vtid,
    status: 'planned',
    planSteps: plan.steps.length
  };
}

/**
 * Emit work started event
 */
export async function emitWorkStarted(
  vtid: string,
  payload: WorkStartedPayload
): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  console.log(`[VTID-0533] Emitting work started for ${vtid}, step: ${payload.stepId}`);

  // Verify task exists
  const taskInfo = await getTaskInfo(vtid);
  if (!taskInfo.exists) {
    return { ok: false, error: `Task ${vtid} not found` };
  }

  // Emit work started event
  const result = await emitAutopilotEvent({
    vtid,
    topic: 'autopilot.work.started',
    status: 'info',
    message: `Work started on step: ${payload.stepId}`,
    metadata: {
      stepId: payload.stepId,
      workerModel: payload.workerModel,
      notes: payload.notes
    }
  });

  // Update task status to 'in-progress'
  if (result.ok) {
    await updateTaskStatus(vtid, 'in-progress');
  }

  return result;
}

/**
 * Emit work completed event
 */
export async function emitWorkCompleted(
  vtid: string,
  payload: WorkCompletedPayload
): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  console.log(`[VTID-0533] Emitting work completed for ${vtid}, step: ${payload.stepId}`);

  // Verify task exists
  const taskInfo = await getTaskInfo(vtid);
  if (!taskInfo.exists) {
    return { ok: false, error: `Task ${vtid} not found` };
  }

  // Emit work completed event
  const result = await emitAutopilotEvent({
    vtid,
    topic: 'autopilot.work.completed',
    status: payload.status === 'success' ? 'success' : 'warning',
    message: payload.outputSummary,
    metadata: {
      stepId: payload.stepId,
      status: payload.status,
      outputSummary: payload.outputSummary,
      details: payload.details || {}
    }
  });

  // Optionally update task status to 'completed' if all work is done
  // For now, keep it as 'in-progress' until validation
  // The validator will set final status

  return result;
}

/**
 * Emit validation completed event
 */
export async function emitValidationResult(
  vtid: string,
  result: ValidationResultPayload,
  metadata: ValidationMetadata
): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  console.log(`[VTID-0533] Emitting validation result for ${vtid}: ${result.status}`);

  // Verify task exists
  const taskInfo = await getTaskInfo(vtid);
  if (!taskInfo.exists) {
    return { ok: false, error: `Task ${vtid} not found` };
  }

  // Emit validation completed event
  const eventResult = await emitAutopilotEvent({
    vtid,
    topic: 'autopilot.validation.completed',
    status: result.status === 'approved' ? 'success' : 'warning',
    message: result.status === 'approved'
      ? 'Validation passed'
      : `Validation failed: ${result.issues?.length || 0} issues found`,
    metadata: {
      validationStatus: result.status,
      issues: result.issues || [],
      notes: result.notes,
      validatorModel: metadata.validatorModel,
      validatorRole: metadata.validatorRole
    }
  });

  // Update task status based on validation result
  if (eventResult.ok) {
    const newStatus: AutopilotTaskStatus = result.status === 'approved' ? 'validated' : 'in-progress';
    await updateTaskStatus(vtid, newStatus, {
      ...taskInfo.metadata,
      validationStatus: result.status,
      validatedAt: new Date().toISOString(),
      validatorModel: metadata.validatorModel
    });
  }

  return eventResult;
}

/**
 * Get task status for the autopilot pipeline
 */
export async function getAutopilotTaskStatus(vtid: string): Promise<TaskStatusResponse | null> {
  console.log(`[VTID-0533] Getting task status for ${vtid}`);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0533] Supabase not configured');
    return null;
  }

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/VtidLedger?vtid=eq.${encodeURIComponent(vtid)}&select=vtid,status,title,metadata,created_at,updated_at&limit=1`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!resp.ok) {
      console.warn(`[VTID-0533] Task status query failed: ${resp.status}`);
      return null;
    }

    const data = await resp.json() as Array<{
      vtid: string;
      status: string;
      title: string;
      metadata?: Record<string, unknown>;
      created_at: string;
      updated_at: string;
    }>;

    if (data.length === 0) {
      return null;
    }

    const task = data[0];
    const metadata = task.metadata || {};
    const plan = metadata.plan as PlanPayload | undefined;

    return {
      vtid: task.vtid,
      status: task.status as AutopilotTaskStatus,
      title: task.title,
      planSteps: plan?.steps?.length,
      validationStatus: metadata.validationStatus as 'pending' | 'approved' | 'rejected' | undefined,
      createdAt: task.created_at,
      updatedAt: task.updated_at
    };
  } catch (error: any) {
    console.warn(`[VTID-0533] Task status error: ${error.message}`);
    return null;
  }
}
