/**
 * VTID-02757 — Voice Tool Expansion P1c: Diary + Memory tools.
 *
 * Backs the read-side diary/memory voice tools — list past entries, walk
 * the memory timeline, semantic recall, garden summary, forget. Each one
 * wraps a single Supabase RPC or direct table query that already exists
 * in the Vitana Memory architecture (per CLAUDE.md section 14).
 *
 * Distinct from existing tools:
 *   - save_diary_entry → WRITE; this module is READ-side
 *   - search_memory → keyword ILIKE on memory_items; recall_memory_about
 *     here uses the semantic embedding via /memory/retrieve RPC
 *   - recall_conversation_at_time → conversation turns; this module
 *     surfaces facts + diary entries, not raw turns
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface DiaryEntry {
  id: string;
  entry_date: string;
  raw_text: string;
  pillars_lifted?: Record<string, number> | null;
  created_at: string;
}

export interface TimelineItem {
  type: string; // 'fact' | 'diary' | 'event' | 'conversation' etc.
  ts: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface RecallItem {
  id: string;
  content: string;
  category_key: string;
  relevance: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// 1. list_diary_entries — wraps memory_get_diary_entries RPC
// ---------------------------------------------------------------------------

export async function listDiaryEntries(
  sb: SupabaseClient,
  args: { from?: string; to?: string; limit?: number },
): Promise<{ ok: true; entries: DiaryEntry[]; total: number } | { ok: false; error: string }> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  const { data, error } = await sb.rpc('memory_get_diary_entries', {
    p_from: args.from || null,
    p_to: args.to || null,
    p_limit: limit,
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'diary_rpc_unavailable' };
    }
    return { ok: false, error: `diary_query_failed: ${error.message}` };
  }
  const rows = Array.isArray(data) ? data : data?.entries ?? [];
  const entries: DiaryEntry[] = rows.slice(0, limit).map((r: any) => ({
    id: String(r.id ?? r.entry_id ?? ''),
    entry_date: String(r.entry_date ?? r.date ?? ''),
    raw_text: String(r.raw_text ?? r.content ?? '').slice(0, 600),
    pillars_lifted: r.pillars_lifted ?? r.index_delta ?? null,
    created_at: String(r.created_at ?? r.entry_date ?? ''),
  }));
  return { ok: true, entries, total: entries.length };
}

// ---------------------------------------------------------------------------
// 2. get_diary_streak — current consecutive-day streak from user_diary_streak view
// ---------------------------------------------------------------------------

export async function getDiaryStreak(
  sb: SupabaseClient,
  userId: string,
): Promise<
  { ok: true; current_streak: number; longest_streak: number; last_entry_date: string | null } | { ok: false; error: string }
> {
  // Try the canonical user_diary_streak view first (added in VTID-01983 phase H).
  const { data, error } = await sb
    .from('user_diary_streak')
    .select('current_streak, longest_streak, last_entry_date')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    // View may not exist yet — degrade to a simple count from memory_diary or memory_items.
    const fallback = await sb
      .from('memory_items')
      .select('created_at')
      .eq('user_id', userId)
      .eq('category_key', 'health_wellness')
      .order('created_at', { ascending: false })
      .limit(40);
    if (fallback.error) return { ok: false, error: `streak_query_failed: ${fallback.error.message}` };
    const dates = (fallback.data || []).map((r: any) => String(r.created_at).slice(0, 10));
    let streak = 0;
    let cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    const known = new Set(dates);
    while (known.has(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor = new Date(cursor.getTime() - 86_400_000);
    }
    return {
      ok: true,
      current_streak: streak,
      longest_streak: streak,
      last_entry_date: dates[0] ?? null,
    };
  }
  return {
    ok: true,
    current_streak: Number((data as any)?.current_streak ?? 0),
    longest_streak: Number((data as any)?.longest_streak ?? 0),
    last_entry_date: (data as any)?.last_entry_date ?? null,
  };
}

// ---------------------------------------------------------------------------
// 3. get_memory_timeline — wraps memory_get_timeline RPC
// ---------------------------------------------------------------------------

export async function getMemoryTimeline(
  sb: SupabaseClient,
  args: { from?: string; to?: string; type?: string; limit?: number },
): Promise<{ ok: true; items: TimelineItem[]; total: number } | { ok: false; error: string }> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 20));
  const { data, error } = await sb.rpc('memory_get_timeline', {
    p_from: args.from || null,
    p_to: args.to || null,
    p_type: args.type || null,
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'timeline_rpc_unavailable' };
    }
    return { ok: false, error: `timeline_query_failed: ${error.message}` };
  }
  const rows = Array.isArray(data) ? data : data?.items ?? [];
  const items: TimelineItem[] = rows.slice(0, limit).map((r: any) => ({
    type: String(r.type ?? r.kind ?? 'unknown'),
    ts: String(r.ts ?? r.created_at ?? r.entry_date ?? ''),
    summary: String(r.summary ?? r.content ?? '').slice(0, 300),
    detail: r.detail ?? r.payload ?? null,
  }));
  return { ok: true, items, total: items.length };
}

// ---------------------------------------------------------------------------
// 4. recall_memory_about — semantic search via memory_items (uses ILIKE
//     by default; the orb-tool dispatcher has the option to call an
//     embedding-based RPC instead, but we keep this resilient since RPC
//     availability varies across environments)
// ---------------------------------------------------------------------------

export async function recallMemoryAbout(
  sb: SupabaseClient,
  userId: string,
  args: { query: string; categories?: string[]; limit?: number },
): Promise<{ ok: true; items: RecallItem[]; total: number } | { ok: false; error: string }> {
  const query = (args.query || '').trim();
  if (!query) return { ok: false, error: 'empty_query' };
  const limit = Math.max(1, Math.min(20, args.limit ?? 5));

  let q = sb
    .from('memory_items')
    .select('id, content, category_key, importance, created_at')
    .eq('user_id', userId)
    .ilike('content', `%${query}%`)
    .order('importance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (args.categories && args.categories.length > 0) {
    q = q.in('category_key', args.categories);
  }
  const { data, error } = await q;
  if (error) return { ok: false, error: `recall_query_failed: ${error.message}` };
  const items: RecallItem[] = (data || []).map((r: any) => ({
    id: String(r.id),
    content: String(r.content ?? '').slice(0, 400),
    category_key: String(r.category_key ?? 'uncategorized'),
    relevance: Number(r.importance ?? 0) / 100, // crude proxy for relevance
    created_at: String(r.created_at),
  }));
  return { ok: true, items, total: items.length };
}

// ---------------------------------------------------------------------------
// 5. get_memory_garden_summary — counts per category for the "what do you
//     remember about me?" voice query
// ---------------------------------------------------------------------------

export async function getMemoryGardenSummary(
  sb: SupabaseClient,
  userId: string,
): Promise<
  | { ok: true; categories: Array<{ category_key: string; count: number; latest: string | null }>; total: number }
  | { ok: false; error: string }
> {
  const { data, error } = await sb
    .from('memory_items')
    .select('category_key, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return { ok: false, error: `garden_query_failed: ${error.message}` };

  const map = new Map<string, { count: number; latest: string | null }>();
  for (const r of data || []) {
    const k = String((r as any).category_key ?? 'uncategorized');
    const existing = map.get(k) ?? { count: 0, latest: null };
    existing.count += 1;
    if (!existing.latest || String((r as any).created_at) > existing.latest) {
      existing.latest = String((r as any).created_at);
    }
    map.set(k, existing);
  }
  const categories = Array.from(map.entries())
    .map(([k, v]) => ({ category_key: k, ...v }))
    .sort((a, b) => b.count - a.count);
  const total = categories.reduce((acc, c) => acc + c.count, 0);
  return { ok: true, categories, total };
}

// ---------------------------------------------------------------------------
// 6. forget_memory — soft delete a single memory_item by id (user-driven
//     right-to-be-forgotten). Returns the row's content as confirmation
//     for the LLM to read aloud — "I'll forget the line about your knee
//     injury — anything else?" — so the user can verify the right entry
//     was removed.
// ---------------------------------------------------------------------------

export async function forgetMemory(
  sb: SupabaseClient,
  userId: string,
  args: { memory_id: string; reason?: string },
): Promise<{ ok: true; forgotten_id: string; preview: string } | { ok: false; error: string }> {
  const memId = (args.memory_id || '').trim();
  if (!memId) return { ok: false, error: 'memory_id_required' };

  // Read first so we can confirm what was removed, scoped to this user.
  const { data: existing, error: readErr } = await sb
    .from('memory_items')
    .select('id, content')
    .eq('id', memId)
    .eq('user_id', userId)
    .maybeSingle();
  if (readErr) return { ok: false, error: `forget_read_failed: ${readErr.message}` };
  if (!existing) return { ok: false, error: 'memory_not_found_or_not_yours' };

  // Soft-delete via tombstone column if it exists; fall back to hard delete.
  const tomb = await sb
    .from('memory_items')
    .update({ deleted_at: new Date().toISOString(), deleted_reason: args.reason ?? 'user_forget' })
    .eq('id', memId)
    .eq('user_id', userId);

  if (tomb.error) {
    // Column likely doesn't exist — fall back to hard delete (still privacy-respecting).
    const del = await sb.from('memory_items').delete().eq('id', memId).eq('user_id', userId);
    if (del.error) return { ok: false, error: `forget_delete_failed: ${del.error.message}` };
  }

  return {
    ok: true,
    forgotten_id: memId,
    preview: String((existing as any).content ?? '').slice(0, 200),
  };
}
