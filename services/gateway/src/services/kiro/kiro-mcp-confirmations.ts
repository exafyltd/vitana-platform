/**
 * VTID-05006: the in-thread Allow/Deny for a Kiro write.
 *
 * The MCP route calls requestConfirmation() before any write tool runs. It
 * inserts a 'pending' row (kiro_mcp_confirmations), then polls it while the
 * HTTP call is held. The user answers from the Kiro thread in the Command Hub
 * (decideConfirmation(), their own pending rows only, atomic). DB-backed, so
 * the answer may land on any gateway task.
 *
 * Time budget, all inside the ALB's 120 s idle timeout: 60 s to answer, then
 * the tool gets whatever is left of 110 s; the relay waits 115 s. If the call
 * goes away first (signal aborted: Kiro gave up or the connection closed) the
 * row is marked 'expired' and a late Allow does nothing.
 */
import { getSupabase } from '../../lib/supabase';

export const KIRO_CONFIRM_WINDOW_MS = 60_000;
export const KIRO_WRITE_CALL_BUDGET_MS = 110_000;
const POLL_MS = 1_000;

export type ConfirmationOutcome = 'allowed' | 'denied' | 'expired';
export interface ConfirmationRequest { userId: string; threadId: string; tool: string; vtid: string | null; summary: string }
export interface PendingConfirmation { id: string; tool: string; vtid: string | null; summary: string; created_at: string }

/** The table, behind a small interface so the tests can run it in memory. */
export interface ConfirmationStore {
  insert(r: ConfirmationRequest): Promise<string | null>;
  status(id: string): Promise<string | null>;
  /** Move a pending row to `to`; true only if this call made the change. */
  settle(id: string, to: 'allowed' | 'denied' | 'expired', userId?: string): Promise<boolean>;
  pending(userId: string, threadId: string): Promise<PendingConfirmation[]>;
}

const T = 'kiro_mcp_confirmations';

export const supabaseConfirmationStore: ConfirmationStore = {
  async insert(r) {
    const db = getSupabase();
    if (!db) return null;
    const { data, error } = await db.from(T)
      .insert({ user_id: r.userId, thread_id: r.threadId, tool: r.tool, vtid: r.vtid, summary: r.summary.slice(0, 600) })
      .select('id').single();
    return error || !data ? null : (data as { id: string }).id;
  },
  async status(id) {
    const db = getSupabase();
    if (!db) return null;
    const { data } = await db.from(T).select('status').eq('id', id).maybeSingle();
    return (data as { status?: string } | null)?.status ?? null;
  },
  async settle(id, to, userId) {
    const db = getSupabase();
    if (!db) return false;
    let q = db.from(T).update({ status: to, decided_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending');
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q.select('id');
    return !error && Array.isArray(data) && data.length === 1;
  },
  async pending(userId, threadId) {
    const db = getSupabase();
    if (!db) return [];
    const since = new Date(Date.now() - KIRO_CONFIRM_WINDOW_MS - 5_000).toISOString();
    const { data } = await db.from(T).select('id, tool, vtid, summary, created_at')
      .eq('user_id', userId).eq('thread_id', threadId).eq('status', 'pending').gte('created_at', since)
      .order('created_at', { ascending: true }).limit(10);
    return (data as PendingConfirmation[] | null) ?? [];
  },
};

let store: ConfirmationStore = supabaseConfirmationStore;
/** Tests only. */
export function setConfirmationStore(s: ConfirmationStore | null): void { store = s ?? supabaseConfirmationStore; }
export function confirmationStore(): ConfirmationStore { return store; }

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Ask the user and wait for the answer. Anything but an Allow is a no. */
export async function requestConfirmation(
  r: ConfirmationRequest,
  signal: AbortSignal,
  opts: { windowMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<{ outcome: ConfirmationOutcome; id: string | null }> {
  const windowMs = opts.windowMs ?? KIRO_CONFIRM_WINDOW_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const now = opts.now ?? Date.now;
  const id = await store.insert(r);
  if (!id) return { outcome: 'expired', id: null };
  const deadline = now() + windowMs;
  while (!signal.aborted && now() < deadline) {
    const s = await store.status(id);
    if (s === 'allowed' || s === 'denied' || s === 'expired') return { outcome: s, id };
    await sleep(pollMs, signal);
  }
  // Gone or out of time: close the row so a late Allow changes nothing.
  if (await store.settle(id, 'expired')) return { outcome: 'expired', id };
  const s = await store.status(id);
  return { outcome: s === 'allowed' ? 'allowed' : s === 'denied' ? 'denied' : 'expired', id };
}

/** The user's answer from the Command Hub: only their own pending row, only once. */
export async function decideConfirmation(id: string, userId: string, decision: 'allow' | 'deny'): Promise<boolean> {
  return store.settle(id, decision === 'allow' ? 'allowed' : 'denied', userId);
}
