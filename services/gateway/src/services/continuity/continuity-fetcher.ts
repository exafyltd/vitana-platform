/**
 * VTID-02932 (B2) — Supabase-backed continuity fetcher.
 *
 * Read-only by design. NO write/mutator methods on the interface —
 * state advancement (creating threads / marking promises kept/broken)
 * lives in a follow-up slice behind dedicated event paths. Even
 * adding an `upsert*` method here would violate the B2 wall.
 *
 * Failure policy: any Supabase error returns empty arrays + source-
 * health flagged. We never throw upward — the continuity context is
 * an enrichment layer, never a wake-blocker.
 */

import { getSupabase } from '../../lib/supabase';
import type {
  OpenThreadRow,
  AssistantPromiseRow,
  OpenThreadStatus,
  PromiseStatus,
} from './types';

export interface ContinuityFetcher {
  listOpenThreads(args: {
    tenantId: string;
    userId: string;
    /** Default 20. Capped at 50. */
    limit?: number;
  }): Promise<{ ok: boolean; rows: OpenThreadRow[]; reason?: string }>;
  listPromises(args: {
    tenantId: string;
    userId: string;
    /** Default 20. Capped at 50. */
    limit?: number;
    /** Filter by status. When absent, returns all statuses. */
    status?: PromiseStatus;
  }): Promise<{ ok: boolean; rows: AssistantPromiseRow[]; reason?: string }>;
}

export interface SupabaseContinuityFetcherOptions {
  getDb?: typeof getSupabase;
}

export function createSupabaseContinuityFetcher(
  opts: SupabaseContinuityFetcherOptions = {},
): ContinuityFetcher {
  const getDb = opts.getDb ?? getSupabase;

  return {
    async listOpenThreads(args) {
      const limit = clampLimit(args.limit);
      const sb = getDb();
      if (!sb) {
        return { ok: false, rows: [], reason: 'supabase_unconfigured' };
      }
      try {
        const { data, error } = await sb
          .from('user_open_threads')
          .select(
            'thread_id, topic, summary, status, session_id_first, session_id_last, last_mentioned_at, resolved_at, created_at, updated_at',
          )
          .eq('tenant_id', args.tenantId)
          .eq('user_id', args.userId)
          .order('last_mentioned_at', { ascending: false })
          .limit(limit);
        if (error) {
          return { ok: false, rows: [], reason: error.message };
        }
        if (!Array.isArray(data)) {
          return { ok: true, rows: [] };
        }
        return { ok: true, rows: data.map(mapThreadRow) };
      } catch (e) {
        return { ok: false, rows: [], reason: (e as Error).message };
      }
    },

    async listPromises(args) {
      const limit = clampLimit(args.limit);
      const sb = getDb();
      if (!sb) {
        return { ok: false, rows: [], reason: 'supabase_unconfigured' };
      }
      try {
        let q = sb
          .from('assistant_promises')
          .select(
            'promise_id, thread_id, session_id, promise_text, due_at, status, decision_id, kept_at, created_at, updated_at',
          )
          .eq('tenant_id', args.tenantId)
          .eq('user_id', args.userId)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (args.status) q = q.eq('status', args.status);
        const { data, error } = await q;
        if (error) {
          return { ok: false, rows: [], reason: error.message };
        }
        if (!Array.isArray(data)) {
          return { ok: true, rows: [] };
        }
        return { ok: true, rows: data.map(mapPromiseRow) };
      } catch (e) {
        return { ok: false, rows: [], reason: (e as Error).message };
      }
    },
  };
}

export const defaultContinuityFetcher = createSupabaseContinuityFetcher();

// ---------------------------------------------------------------------------
// Row mappers — exported for tests
// ---------------------------------------------------------------------------

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 20;
  return Math.max(1, Math.min(50, Math.trunc(raw)));
}

const KNOWN_THREAD_STATUSES: ReadonlySet<OpenThreadStatus> = new Set<OpenThreadStatus>([
  'open', 'resolved', 'abandoned',
]);
const KNOWN_PROMISE_STATUSES: ReadonlySet<PromiseStatus> = new Set<PromiseStatus>([
  'owed', 'kept', 'broken', 'cancelled',
]);

export function mapThreadRow(row: Record<string, unknown>): OpenThreadRow {
  const statusRaw = typeof row.status === 'string' ? row.status : 'open';
  const status: OpenThreadStatus = KNOWN_THREAD_STATUSES.has(statusRaw as OpenThreadStatus)
    ? (statusRaw as OpenThreadStatus)
    : 'open';
  return {
    thread_id: String(row.thread_id ?? ''),
    topic: String(row.topic ?? ''),
    summary: typeof row.summary === 'string' ? row.summary : null,
    status,
    session_id_first: typeof row.session_id_first === 'string' ? row.session_id_first : null,
    session_id_last: typeof row.session_id_last === 'string' ? row.session_id_last : null,
    last_mentioned_at: String(row.last_mentioned_at ?? ''),
    resolved_at: typeof row.resolved_at === 'string' ? row.resolved_at : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

export function mapPromiseRow(row: Record<string, unknown>): AssistantPromiseRow {
  const statusRaw = typeof row.status === 'string' ? row.status : 'owed';
  const status: PromiseStatus = KNOWN_PROMISE_STATUSES.has(statusRaw as PromiseStatus)
    ? (statusRaw as PromiseStatus)
    : 'owed';
  return {
    promise_id: String(row.promise_id ?? ''),
    thread_id: typeof row.thread_id === 'string' ? row.thread_id : null,
    session_id: typeof row.session_id === 'string' ? row.session_id : null,
    promise_text: String(row.promise_text ?? ''),
    due_at: typeof row.due_at === 'string' ? row.due_at : null,
    status,
    decision_id: typeof row.decision_id === 'string' ? row.decision_id : null,
    kept_at: typeof row.kept_at === 'string' ? row.kept_at : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}
