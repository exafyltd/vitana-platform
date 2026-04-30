/**
 * VTID-01990: Idle Session Closer
 *
 * Background worker that finds text-channel threads idle for >= 4h and writes
 * a session summary via recordSessionSummary (which itself calls Gemini Flash).
 * Voice already writes its own summaries on disconnect from orb-live.ts; this
 * closer handles the text-channel parity so the awareness builder sees text
 * sessions in user_session_summaries too.
 *
 * Pattern mirrors self-healing-reconciler: setInterval, idempotent, swallows
 * its own errors, no DB writes outside the canonical recordSessionSummary
 * path. Runs every 5 minutes; closes threads whose last conversation_messages
 * row is older than the configured idle threshold (default 4h, matching
 * resolve_thread_id's default p_session_timeout_hours=4).
 *
 * Disabled when SUPABASE_URL / SUPABASE_SERVICE_ROLE missing, or when the
 * IDLE_SESSION_CLOSER_ENABLED env var is explicitly 'false'.
 */

import { getSupabase } from '../lib/supabase';
import { recordSessionSummary } from './guide/session-summaries';

const LOG_PREFIX = '[VTID-01990:idle-session-closer]';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_IDLE_HOURS = 4; // matches resolve_thread_id's session timeout
const MAX_THREADS_PER_CYCLE = 10;
const MAX_TURNS_PER_SESSION = 50;

let timer: NodeJS.Timeout | null = null;
let running = false;
let cycleInFlight = false;

interface IdleThreadRow {
  thread_id: string;
  user_id: string;
  tenant_id: string;
  last_activity_at: string;
  first_activity_at: string;
  channel: string;
  turn_count: number;
}

async function findIdleThreadsToSummarize(idleHours: number): Promise<IdleThreadRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return [];

  // PostgREST doesn't support GROUP BY + aggregates ergonomically — use the
  // SQL endpoint pattern: a one-shot RPC would be cleaner, but we already
  // have everything we need from the existing tables. Use a raw HTTP RPC
  // call only if needed; for now, do a simpler approach: pull recent
  // distinct threads from conversation_messages, then check each against
  // user_session_summaries.
  const cutoffIso = new Date(Date.now() - idleHours * 3600 * 1000).toISOString();
  const supabase = getSupabase();
  if (!supabase) return [];

  // Step 1: list candidate text-channel threads with their newest activity.
  // We grab a recent window so the closer doesn't scan the whole table.
  const lookbackIso = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(); // last 14 days
  const { data: msgs, error: msgErr } = await supabase
    .from('conversation_messages')
    .select('thread_id, user_id, tenant_id, channel, created_at')
    .neq('channel', 'orb') // voice writes its own summaries via orb-live.ts
    .gte('created_at', lookbackIso)
    .order('created_at', { ascending: false })
    .limit(2000);

  if (msgErr) {
    console.warn(`${LOG_PREFIX} message scan failed: ${msgErr.message}`);
    return [];
  }
  if (!msgs || msgs.length === 0) return [];

  // Reduce to (thread_id, user_id) -> { last_activity, first_activity, channel, turn_count }.
  // The query is ordered DESC, so first occurrence per thread is the newest.
  const byThread = new Map<
    string,
    { thread_id: string; user_id: string; tenant_id: string; channel: string; first: string; last: string; count: number }
  >();
  for (const row of msgs as Array<{
    thread_id: string;
    user_id: string;
    tenant_id: string;
    channel: string;
    created_at: string;
  }>) {
    const key = row.thread_id;
    const existing = byThread.get(key);
    if (!existing) {
      byThread.set(key, {
        thread_id: row.thread_id,
        user_id: row.user_id,
        tenant_id: row.tenant_id,
        channel: row.channel,
        first: row.created_at,
        last: row.created_at,
        count: 1,
      });
    } else {
      existing.count += 1;
      // ascending oldest
      if (row.created_at < existing.first) existing.first = row.created_at;
      if (row.created_at > existing.last) existing.last = row.created_at;
    }
  }

  // Filter to threads that are idle (last activity older than the cutoff)
  const idle: IdleThreadRow[] = [];
  for (const t of byThread.values()) {
    if (t.last < cutoffIso) {
      idle.push({
        thread_id: t.thread_id,
        user_id: t.user_id,
        tenant_id: t.tenant_id,
        last_activity_at: t.last,
        first_activity_at: t.first,
        channel: t.channel,
        turn_count: t.count,
      });
    }
  }
  if (idle.length === 0) return [];

  // Step 2: filter out threads that already have a summary
  const sessionIds = idle.map((t) => t.thread_id);
  const { data: existing, error: existingErr } = await supabase
    .from('user_session_summaries')
    .select('session_id, user_id')
    .in('session_id', sessionIds);

  if (existingErr) {
    console.warn(`${LOG_PREFIX} existing-summary check failed: ${existingErr.message}`);
    return [];
  }
  const existingKeys = new Set<string>();
  for (const row of (existing || []) as Array<{ session_id: string; user_id: string }>) {
    existingKeys.add(`${row.user_id}::${row.session_id}`);
  }

  const ready = idle.filter((t) => !existingKeys.has(`${t.user_id}::${t.thread_id}`));
  // Sort newest-first so the most recently idle threads close first
  ready.sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
  return ready.slice(0, MAX_THREADS_PER_CYCLE);
}

async function fetchTranscript(
  threadId: string,
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('conversation_messages')
    .select('role, content, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(MAX_TURNS_PER_SESSION);

  if (error || !data) {
    if (error) console.warn(`${LOG_PREFIX} transcript fetch failed: ${error.message}`);
    return [];
  }

  return (data as Array<{ role: string; content: string }>).map((m) => ({
    role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
    text: m.content || '',
  }));
}

async function closeOne(thread: IdleThreadRow): Promise<void> {
  const turns = await fetchTranscript(thread.thread_id);
  if (turns.length === 0) {
    console.log(`${LOG_PREFIX} thread ${thread.thread_id.slice(0, 12)} has no turns — skipping`);
    return;
  }

  const durationMs =
    new Date(thread.last_activity_at).getTime() - new Date(thread.first_activity_at).getTime();

  const result = await recordSessionSummary({
    user_id: thread.user_id,
    session_id: thread.thread_id,
    channel: 'text',
    transcript_turns: turns,
    duration_ms: durationMs > 0 ? durationMs : null,
  });

  if (!result.success) {
    console.warn(
      `${LOG_PREFIX} closeOne failed thread=${thread.thread_id.slice(0, 12)} error=${result.error}`,
    );
  } else {
    console.log(
      `${LOG_PREFIX} closed thread=${thread.thread_id.slice(0, 12)} user=${thread.user_id.slice(0, 8)} turns=${turns.length}`,
    );
  }
}

async function runCycle(idleHours: number): Promise<void> {
  if (cycleInFlight) {
    console.log(`${LOG_PREFIX} cycle already in flight — skipping`);
    return;
  }
  cycleInFlight = true;
  try {
    const threads = await findIdleThreadsToSummarize(idleHours);
    if (threads.length === 0) return;
    console.log(`${LOG_PREFIX} closing ${threads.length} idle thread(s)`);
    // Sequential to keep Gemini Flash QPS predictable; cycle is bounded.
    for (const t of threads) {
      try {
        await closeOne(t);
      } catch (err: any) {
        console.warn(`${LOG_PREFIX} closeOne threw: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} cycle error: ${err.message}`);
  } finally {
    cycleInFlight = false;
  }
}

export function startIdleSessionCloser(): void {
  if (running) {
    console.log(`${LOG_PREFIX} already running`);
    return;
  }
  if ((process.env.IDLE_SESSION_CLOSER_ENABLED ?? 'true').toLowerCase() === 'false') {
    console.log(`${LOG_PREFIX} disabled via IDLE_SESSION_CLOSER_ENABLED=false`);
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn(`${LOG_PREFIX} Supabase credentials missing — closer not started`);
    return;
  }

  const intervalMs = parseInt(
    process.env.IDLE_SESSION_CLOSER_INTERVAL_MS || String(DEFAULT_INTERVAL_MS),
    10,
  );
  const idleHours = parseInt(process.env.IDLE_SESSION_CLOSER_IDLE_HOURS || String(DEFAULT_IDLE_HOURS), 10);

  running = true;
  // First cycle 60s after boot so the gateway is warm
  setTimeout(() => void runCycle(idleHours), 60_000);
  timer = setInterval(() => void runCycle(idleHours), intervalMs);
  console.log(
    `🗂️  VTID-01990 idle-session-closer started (interval=${intervalMs}ms, idle_threshold=${idleHours}h)`,
  );
}

export function stopIdleSessionCloser(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
  console.log(`${LOG_PREFIX} stopped`);
}
