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

    const { data: membership } = await sb
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', t.user_id)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();
    const tenantId = (membership as { tenant_id?: string } | null)?.tenant_id;
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
