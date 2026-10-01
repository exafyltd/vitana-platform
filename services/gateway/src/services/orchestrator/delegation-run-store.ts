/**
 * VTID-04415 (Orchestrator v2, P3 → P4): delegation jobs written to the
 * native run ledger (`agent_runs`, VTID-04319) as they start and finish.
 *
 * The dispatcher keeps jobs in process memory (dispatcher.ts header). A voice
 * session is pinned to one gateway task, but the NEXT session may land on
 * another one — and then "what did support find?" has nothing to read. This
 * store is a write-through copy: memory stays the primary source, and a job
 * the local task does not hold is looked up here by the same owner rules
 * (same user, same surface).
 *
 * Opt-in (`ORCHESTRATOR_DELEGATION_PERSIST_ENABLED`, exact 'true'); fail-open
 * everywhere — a write or read failure logs once per call and never touches
 * the delegation itself. Cancel stays memory-only on purpose: a job running
 * on another task cannot be stopped from here, and marking it cancelled in the
 * row would only be overwritten when that task finishes it.
 *
 * `agent_runs` has browser roles revoked (VTID-04319); only the gateway's
 * service role reads or writes it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbSurface } from '../../orb/live/surface';

export const DELEGATION_PERSIST_ENABLED_ENV = 'ORCHESTRATOR_DELEGATION_PERSIST_ENABLED';
export const DELEGATION_RUN_PLANE = 'orb';
export const MAX_PERSISTED_INTENT_CHARS = 500;
export const MAX_PERSISTED_RESULT_CHARS = 8_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOG_PREFIX = '[delegation-run-store]';

export type PersistedJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** The job fields the store needs — structurally the dispatcher's DelegationJob. */
export interface PersistableJob {
  job_id: string;
  agent_id: string;
  user_id: string | null;
  surface: OrbSurface;
  session_id: string | null;
  status: PersistedJobStatus;
  request: string;
  result: unknown;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PersistableCaller {
  tenant_id: string | null;
  platform_role: string | null;
  channel: string;
}

export interface DelegationRunStore {
  recordStart(job: PersistableJob, caller: PersistableCaller, tier: string): Promise<void>;
  recordFinish(job: PersistableJob): Promise<void>;
  find(jobId: string, owner: { user_id: string; surface: OrbSurface }): Promise<PersistableJob | null>;
  latest(owner: { user_id: string; surface: OrbSurface }): Promise<PersistableJob | null>;
}

export function isDelegationPersistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DELEGATION_PERSIST_ENABLED_ENV] === 'true';
}

/** Rows are keyed by uuid columns; anything else is simply not persisted. */
export function isPersistableJob(job: Pick<PersistableJob, 'job_id' | 'user_id'>): boolean {
  return UUID_RE.test(job.job_id) && !!job.user_id && UUID_RE.test(job.user_id);
}

const CREATED_VIA = new Set(['voice', 'chat', 'web', 'system', 'ci']);

/** Bounded, JSON-safe result for `result_ref`. */
export function boundResult(result: unknown): { result: unknown; truncated: boolean } {
  if (result === null || result === undefined) return { result: null, truncated: false };
  let text: string;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    return { result: String(result).slice(0, MAX_PERSISTED_RESULT_CHARS), truncated: true };
  }
  if (text.length <= MAX_PERSISTED_RESULT_CHARS) return { result, truncated: false };
  return { result: text.slice(0, MAX_PERSISTED_RESULT_CHARS), truncated: true };
}

export function toStartRow(job: PersistableJob, caller: PersistableCaller, tier: string): Record<string, unknown> {
  return {
    id: job.job_id,
    agent_id: job.agent_id,
    plane: DELEGATION_RUN_PLANE,
    principal: { platform_role: caller.platform_role, surface: job.surface, channel: caller.channel },
    user_id: job.user_id,
    tenant_id: caller.tenant_id && UUID_RE.test(caller.tenant_id) ? caller.tenant_id : null,
    intent: job.request.slice(0, MAX_PERSISTED_INTENT_CHARS),
    status: job.status,
    tier: ['read', 'draft', 'commit', 'high'].includes(tier) ? tier : null,
    created_via: CREATED_VIA.has(caller.channel) ? caller.channel : 'system',
    metadata: { surface: job.surface, session_id: job.session_id, source: 'delegate_to_agent' },
    created_at: job.created_at,
  };
}

export function toFinishPatch(job: PersistableJob): Record<string, unknown> {
  const bounded = boundResult(job.result);
  return {
    status: job.status,
    result_ref: job.status === 'succeeded' ? { result: bounded.result, truncated: bounded.truncated } : null,
    error: job.error ? job.error.slice(0, 1_000) : null,
    completed_at: job.completed_at,
    updated_at: new Date().toISOString(),
  };
}

type Row = {
  id: string; agent_id: string; user_id: string | null; status: string; intent: string | null;
  result_ref: { result?: unknown } | null; error: string | null; metadata: Record<string, unknown> | null;
  created_at: string; completed_at: string | null;
};

export function fromRow(row: Row): PersistableJob | null {
  const surface = row.metadata?.surface;
  if (typeof surface !== 'string') return null;
  const status = (['running', 'succeeded', 'failed', 'cancelled'] as const).find((s) => s === row.status);
  // queued / waiting_signal / awaiting_approval are not states a delegation writes.
  if (!status) return null;
  return {
    job_id: row.id,
    agent_id: row.agent_id,
    user_id: row.user_id,
    surface: surface as OrbSurface,
    session_id: typeof row.metadata?.session_id === 'string' ? (row.metadata.session_id as string) : null,
    status,
    request: row.intent ?? '',
    result: row.result_ref?.result ?? null,
    error: row.error,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

const SELECT_COLUMNS = 'id, agent_id, user_id, status, intent, result_ref, error, metadata, created_at, completed_at';

export function createSupabaseDelegationRunStore(getClient: () => Promise<SupabaseClient>): DelegationRunStore {
  const warn = (what: string, err: unknown) =>
    console.warn(`${LOG_PREFIX} ${what} failed:`, err instanceof Error ? err.message : err);

  return {
    async recordStart(job, caller, tier) {
      if (!isPersistableJob(job)) return;
      try {
        const sb = await getClient();
        const { error } = await sb.from('agent_runs').insert(toStartRow(job, caller, tier));
        if (error) warn('insert', error.message);
      } catch (err) { warn('insert', err); }
    },
    async recordFinish(job) {
      if (!isPersistableJob(job)) return;
      try {
        const sb = await getClient();
        const { error } = await sb.from('agent_runs').update(toFinishPatch(job))
          .eq('id', job.job_id).eq('plane', DELEGATION_RUN_PLANE);
        if (error) warn('update', error.message);
      } catch (err) { warn('update', err); }
    },
    async find(jobId, owner) {
      if (!UUID_RE.test(jobId) || !UUID_RE.test(owner.user_id)) return null;
      try {
        const sb = await getClient();
        const { data, error } = await sb.from('agent_runs').select(SELECT_COLUMNS)
          .eq('id', jobId).eq('plane', DELEGATION_RUN_PLANE).eq('user_id', owner.user_id)
          .eq('metadata->>surface', owner.surface).maybeSingle();
        if (error) { warn('find', error.message); return null; }
        return data ? fromRow(data as Row) : null;
      } catch (err) { warn('find', err); return null; }
    },
    async latest(owner) {
      if (!UUID_RE.test(owner.user_id)) return null;
      try {
        const sb = await getClient();
        const { data, error } = await sb.from('agent_runs').select(SELECT_COLUMNS)
          .eq('plane', DELEGATION_RUN_PLANE).eq('user_id', owner.user_id)
          .eq('metadata->>surface', owner.surface)
          .order('created_at', { ascending: false }).limit(1);
        if (error) { warn('latest', error.message); return null; }
        const row = (data as Row[] | null)?.[0];
        return row ? fromRow(row) : null;
      } catch (err) { warn('latest', err); return null; }
    },
  };
}

let cachedClient: SupabaseClient | null = null;
async function serviceClient(): Promise<SupabaseClient> {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('Supabase is not configured');
  const { createClient } = await import('@supabase/supabase-js');
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

/** The store the dispatcher uses when none was injected: null unless the flag is on. */
export function defaultDelegationRunStore(env: NodeJS.ProcessEnv = process.env): DelegationRunStore | null {
  return isDelegationPersistEnabled(env) ? createSupabaseDelegationRunStore(serviceClient) : null;
}
