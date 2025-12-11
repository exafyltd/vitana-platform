/**
 * VTID-0509 + VTID-0531: Operator Service
 * Business logic for operator console - aggregates data from OASIS/CICD
 *
 * VTID-0531: Added OASIS integration for chat messages with thread/vtid support
 */

import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
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
 */
export async function ingestOperatorEvent(input: OperatorEventInput): Promise<void> {
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
      metadata: input.payload || {}
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
      console.error(`[Operator Service] Event ingest failed: ${resp.status} - ${text}`);
    } else {
      console.log(`[Operator Service] Event ingested: ${input.type}`);
    }
  } catch (error: any) {
    console.error(`[Operator Service] Event ingest error: ${error.message}`);
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
      console.error(`[Operator Service] Tasks query failed: ${resp.status}`);
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
    console.error(`[Operator Service] Tasks summary error: ${error.message}`);
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
      console.error(`[Operator Service] Events query failed: ${resp.status}`);
      return [];
    }

    const events = await resp.json() as Array<{ topic: string; created_at: string; message: string }>;

    return events.map(e => ({
      type: e.topic || 'unknown',
      created_at: e.created_at,
      summary: e.message?.substring(0, 100) || 'No message'
    }));

  } catch (error: any) {
    console.error(`[Operator Service] Recent events error: ${error.message}`);
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
 * Filters: operator.chat.*, operator.heartbeat.*, operator.upload, deploy.*, cicd.*
 */
export async function getOperatorHistory(limit: number = 50): Promise<HistoryEvent[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[Operator Service] Supabase not configured, returning empty history');
    return [];
  }

  try {
    // Query events with topic filter using 'or' for multiple patterns
    // Supabase PostgREST supports 'or' operator for multiple conditions
    const topicPatterns = [
      'topic.like.operator.%',
      'topic.like.deploy.%',
      'topic.like.cicd.%',
      'topic.like.gateway.health.%'
    ].join(',');

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?select=id,topic,status,vtid,created_at,message&or=(${topicPatterns})&order=created_at.desc&limit=${limit}`,
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
        `${SUPABASE_URL}/rest/v1/oasis_events?select=id,topic,status,vtid,created_at,message&order=created_at.desc&limit=${limit}`,
        {
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
          }
        }
      );

      if (!fallbackResp.ok) {
        console.error(`[Operator Service] History fallback query failed: ${fallbackResp.status}`);
        return [];
      }

      const allEvents = await fallbackResp.json() as any[];

      // Filter in memory
      const operatorTypes = ['operator', 'deploy', 'cicd', 'gateway.health'];
      const filtered = allEvents.filter(e => {
        const topic = e.topic || '';
        return operatorTypes.some(t => topic.startsWith(t));
      });

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

    return events.map(e => ({
      id: e.id,
      type: e.topic || 'unknown',
      status: e.status || 'info',
      vtid: e.vtid || null,
      created_at: e.created_at,
      summary: e.message?.substring(0, 150) || 'No message'
    }));

  } catch (error: any) {
    console.error(`[Operator Service] History error: ${error.message}`);
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
      console.error(`[Operator Service] Chat event ingest failed: ${resp.status} - ${text}`);
      return { ok: false, error: `Event ingest failed: ${resp.status}` };
    }

    console.log(`[Operator Service] Chat event ingested: ${eventId} (thread: ${input.threadId}, role: ${input.role})`);
    return { ok: true, eventId };
  } catch (error: any) {
    console.error(`[Operator Service] Chat event ingest error: ${error.message}`);
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
      console.error(`[Operator Service] Thread history query failed: ${resp.status} - ${text}`);
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
    console.error(`[Operator Service] Thread history error: ${error.message}`);
    return [];
  }
}
