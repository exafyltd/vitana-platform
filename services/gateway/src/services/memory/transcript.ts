/**
 * VTID-04387: raw conversation turns live in `memory_transcript_turns`, kept
 * 90 days (owner decision 2026-09-23), never in `memory_items`.
 *
 * `memory_items` is for episodes worth recalling — session summaries, diary
 * entries, daily learnings, Garden notes. On 2026-09-23 2,666 of its 3,183
 * rows were raw user turns, which is most of what semantic recall had to wade
 * through. Raw turns are still needed for two things: rebuilding a session's
 * transcript (the session summary) and "what did I just say?" grounding. Both
 * read this table.
 *
 * Transition: while the session summary is new and unobserved in production,
 * raw turns are ALSO written to memory_items unless
 * MEMORY_RAW_TURNS_TO_ITEMS=false. Flip it to false once
 * `memory.session.summarized` events are observed on staging; then only this
 * table holds raw turns.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { memoryRoleForWrite } from './scope';

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptTurnInput {
  tenant_id: string;
  user_id: string;
  role: TranscriptRole;
  content: string;
  source: string;
  session_id?: string | null;
  conversation_id?: string | null;
  channel?: string | null;
  active_role?: string | null;
  occurred_at?: string;
}

export interface TranscriptTurn {
  role: TranscriptRole;
  content: string;
  occurred_at: string;
  session_id: string | null;
}

/** Content longer than this is truncated before it is stored. */
export const MAX_TURN_CHARS = 8_000;

// A client per call, the same as the bridge's createMemoryClient().
function serviceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  return url && key
    ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;
}

/** True unless MEMORY_RAW_TURNS_TO_ITEMS is exactly 'false'. */
export function rawTurnsAlsoToMemoryItems(): boolean {
  return process.env.MEMORY_RAW_TURNS_TO_ITEMS !== 'false';
}

/** The transcript role for a memory row, or null when the row is not a raw turn. */
export function transcriptRoleOf(contentJson: Record<string, unknown> | undefined | null): TranscriptRole | null {
  const d = contentJson?.direction;
  return d === 'user' || d === 'assistant' ? d : null;
}

/** Record one raw turn. Never throws; returns whether the row was written. */
export async function recordTranscriptTurn(
  input: TranscriptTurnInput,
  client: SupabaseClient | null = serviceClient(),
): Promise<boolean> {
  const content = (input.content || '').trim();
  if (!client || !input.tenant_id || !input.user_id || !content) return false;
  try {
    const { error } = await client.from('memory_transcript_turns').insert({
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      role: input.role,
      content: content.length > MAX_TURN_CHARS ? content.slice(0, MAX_TURN_CHARS) : content,
      source: input.source,
      session_id: input.session_id ?? null,
      conversation_id: input.conversation_id ?? null,
      channel: input.channel ?? null,
      active_role: memoryRoleForWrite(input.active_role),
      occurred_at: input.occurred_at ?? new Date().toISOString(),
    });
    if (error) {
      console.warn(`[VTID-04387] transcript turn write failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[VTID-04387] transcript turn write threw: ${err?.message ?? err}`);
    return false;
  }
}

/** The user's most recent turns, newest first. Empty on any failure. */
export async function fetchRecentTranscriptTurns(
  identity: { tenant_id: string; user_id: string },
  opts: { limit?: number; role?: TranscriptRole } = {},
  client: SupabaseClient | null = serviceClient(),
): Promise<TranscriptTurn[]> {
  if (!client) return [];
  try {
    let q = client
      .from('memory_transcript_turns')
      .select('role, content, occurred_at, session_id')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id);
    if (opts.role) q = q.eq('role', opts.role);
    const { data, error } = await q.order('occurred_at', { ascending: false }).limit(opts.limit ?? 10);
    if (error || !data) return [];
    return data as TranscriptTurn[];
  } catch {
    return [];
  }
}

/** Turns in a time window, oldest first (for rebuilding a session transcript). */
export async function fetchTranscriptWindow(
  identity: { tenant_id: string; user_id: string },
  startIso: string,
  endIso: string,
  client: SupabaseClient | null = serviceClient(),
): Promise<TranscriptTurn[]> {
  if (!client) return [];
  try {
    const { data, error } = await client
      .from('memory_transcript_turns')
      .select('role, content, occurred_at, session_id')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .gte('occurred_at', startIso)
      .lte('occurred_at', endIso)
      .order('occurred_at', { ascending: true })
      .limit(200);
    if (error || !data) return [];
    return data as TranscriptTurn[];
  } catch {
    return [];
  }
}
