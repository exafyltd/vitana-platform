/**
 * VTID-04412 — resolved support tickets become memory.
 *
 * When a member's ticket is resolved, two `support_ticket` episodes are
 * written to memory_items:
 *   - one for the member (active_role NULL — personal memory), so Vitana can
 *     say "that login problem from last week is fixed";
 *   - one with active_role 'support', so the support team's recall can find
 *     how a similar problem was solved before.
 *
 * The text is the ticket's own words — what was reported and how it was
 * resolved — with the ticket number; no model call, nothing invented.
 * Unique per (ticket, role), so a ticket resolved again (or two resolve
 * paths firing) never writes twice. Importance 45: below the
 * trg_notify_memory_garden threshold (> 50).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { embedItemLater } from './embed-item';

export const SUPPORT_EPISODE_IMPORTANCE = 45;
export const SUPPORT_PART_MAX_CHARS = 600;

export interface ResolvedTicket {
  id: string;
  user_id: string | null;
  ticket_number: string | null;
  kind: string | null;
  status: string;
  raw_transcript: string | null;
  resolution_md: string | null;
  draft_answer_md: string | null;
  resolved_at: string | null;
}

function clean(text: string | null | undefined, max = SUPPORT_PART_MAX_CHARS): string | null {
  const t = (text || '')
    .replace(/[#*_`>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** "FB-2026-09-000123 (bug): <reported> → <resolution>"; null when there is nothing to say. */
export function describeResolvedTicket(t: ResolvedTicket): string | null {
  const reported = clean(t.raw_transcript);
  const resolution = clean(t.resolution_md) ?? clean(t.draft_answer_md);
  if (!reported && !resolution) return null;
  const label = `${t.ticket_number ?? t.id.slice(0, 8)}${t.kind ? ` (${t.kind})` : ''}`;
  return `${label}: ${reported ?? '—'} → ${resolution ?? '—'}`;
}

/** The member's primary tenant (the tenant their memory rows live in). */
async function primaryTenantOf(sb: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await sb
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', userId)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
}

export type TicketMemoryOutcome =
  | { status: 'written'; written: number }
  | { status: 'not_resolved' | 'no_reporter' | 'no_tenant' | 'nothing_to_say' | 'not_found' }
  | { status: 'failed'; error: string };

/** Write the member + support episodes for one resolved ticket. Never throws. */
export async function recordResolvedTicketMemory(sb: SupabaseClient, ticketId: string): Promise<TicketMemoryOutcome> {
  try {
    const { data } = await sb
      .from('feedback_tickets')
      .select('id, user_id, ticket_number, kind, status, raw_transcript, resolution_md, draft_answer_md, resolved_at')
      .eq('id', ticketId)
      .maybeSingle();
    const t = data as ResolvedTicket | null;
    if (!t) return { status: 'not_found' };
    if (t.status !== 'resolved' && t.status !== 'user_confirmed') return { status: 'not_resolved' };
    if (!t.user_id) return { status: 'no_reporter' };
    const content = describeResolvedTicket(t);
    if (!content) return { status: 'nothing_to_say' };

    const tenantId = await primaryTenantOf(sb, t.user_id);
    if (!tenantId) return { status: 'no_tenant' };

    const base = {
      tenant_id: tenantId,
      user_id: t.user_id,
      category_key: 'support_ticket',
      source: 'system',
      content,
      importance: SUPPORT_EPISODE_IMPORTANCE,
      occurred_at: t.resolved_at || new Date().toISOString(),
    };
    const json = { kind: 'support_ticket', ticket_id: t.id, ticket_number: t.ticket_number, ticket_kind: t.kind };
    let written = 0;
    for (const role of [null, 'support'] as const) {
      const { data: row, error } = await sb
        .from('memory_items')
        .insert({ ...base, active_role: role, content_json: { ...json, audience: role ?? 'member' } })
        .select('id')
        .single();
      if (error) {
        if (/duplicate key|23505/i.test(error.message)) continue;
        return { status: 'failed', error: error.message };
      }
      written++;
      void embedItemLater((row as any)?.id, content);
    }
    return { status: 'written', written };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// VTID-04431 — the reader: similar resolved tickets for the drafters.
//
// The role:support copies are searched across members of ONE tenant by
// `support_resolution_search` (service_role only), which returns ticket ids,
// never episode text. The resolution shown to a drafter is loaded from
// feedback_tickets: ticket number, kind and the published resolution only —
// never another member's report, name or transcript. Drafts are reviewed by
// a human before anything reaches a member.
// ---------------------------------------------------------------------------

export const PRIOR_RESOLUTIONS_LIMIT = 3;
export const PRIOR_RESOLUTION_MAX_CHARS = 500;
export const PRIOR_RESOLUTIONS_TIMEOUT_MS = 4_000;

export interface PriorResolution {
  ticket_number: string | null;
  kind: string | null;
  resolution: string;
  similarity: number;
}

export function isPriorResolutionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUPPORT_PRIOR_RESOLUTIONS_ENABLED !== 'false';
}

export interface PriorResolutionDeps {
  sb?: SupabaseClient | null;
  embed?: (text: string) => Promise<{ ok: boolean; embedding?: number[] }>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Up to three resolved tickets in the same tenant that look like this one.
 * Never throws; any failure (flag off, no tenant, embedding down, timeout)
 * returns []. The query text is the ticket's own report.
 */
export async function findSimilarResolvedTickets(
  ticketId: string,
  queryText: string,
  deps: PriorResolutionDeps = {},
): Promise<PriorResolution[]> {
  if (!isPriorResolutionsEnabled(deps.env)) return [];
  const text = (queryText || '').trim();
  if (!ticketId || !text) return [];
  const work = (async (): Promise<PriorResolution[]> => {
    let sb = deps.sb;
    if (sb === undefined) {
      const { getSupabase } = await import('../../lib/supabase');
      sb = getSupabase();
    }
    if (!sb) return [];
    const { data: ticket } = await sb.from('feedback_tickets').select('user_id').eq('id', ticketId).maybeSingle();
    const userId = (ticket as { user_id?: string } | null)?.user_id;
    if (!userId) return [];
    const tenantId = await primaryTenantOf(sb, userId);
    if (!tenantId) return [];

    const embed = deps.embed ?? (await import('../memory-embedding')).embedMemoryText;
    const e = await embed(text.slice(0, 2000));
    if (!e.ok || !e.embedding) return [];

    const { data: hits, error } = await sb.rpc('support_resolution_search', {
      p_query_embedding: e.embedding,
      p_tenant_id: tenantId,
      p_top_k: PRIOR_RESOLUTIONS_LIMIT,
      p_exclude_ticket_id: ticketId,
    });
    if (error || !Array.isArray(hits) || hits.length === 0) return [];
    const scores = new Map<string, number>();
    for (const h of hits as Array<{ ticket_id: string | null; similarity: number }>) {
      if (h.ticket_id && !scores.has(h.ticket_id)) scores.set(h.ticket_id, Number(h.similarity) || 0);
    }
    if (scores.size === 0) return [];

    const { data: rows } = await sb
      .from('feedback_tickets')
      .select('id, ticket_number, kind, status, resolution_md, draft_answer_md')
      .in('id', [...scores.keys()]);
    const out: PriorResolution[] = [];
    for (const r of (rows as any[]) || []) {
      if (r.status !== 'resolved' && r.status !== 'user_confirmed') continue;
      const resolution = clean(r.resolution_md, PRIOR_RESOLUTION_MAX_CHARS) ?? clean(r.draft_answer_md, PRIOR_RESOLUTION_MAX_CHARS);
      if (!resolution) continue;
      out.push({ ticket_number: r.ticket_number ?? null, kind: r.kind ?? null, resolution, similarity: scores.get(r.id) ?? 0 });
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, PRIOR_RESOLUTIONS_LIMIT);
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<PriorResolution[]>((resolve) => {
    timer = setTimeout(() => resolve([]), PRIOR_RESOLUTIONS_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.catch(() => []), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The prompt block a drafter appends; '' when there is nothing to show. */
export function renderPriorResolutions(list: PriorResolution[]): string {
  if (!list || list.length === 0) return '';
  return [
    'HOW SIMILAR TICKETS WERE RESOLVED BEFORE (same tenant, reference only)',
    'Use these to inform your draft when they genuinely apply. Do not quote them, do not mention other tickets or other members, and never assume this ticket has the same cause without evidence in the report.',
    ...list.map((p) => `- ${p.ticket_number ?? '(no number)'}${p.kind ? ` (${p.kind})` : ''}: ${p.resolution}`),
  ].join('\n');
}
