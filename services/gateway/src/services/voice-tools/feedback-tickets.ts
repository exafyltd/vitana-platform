/**
 * VTID-02768 — Voice Tool Expansion P1h: Feedback / Specialist tickets.
 *
 * Backs voice tools that let the user file a structured ticket from
 * voice and read back what they've filed. Each ticket maps to a
 * specialist persona via its `kind`:
 *
 *   bug | ux_issue | feature_request   → Devon (engineer)
 *   support_question | feedback        → Sage (support)
 *   marketplace_claim                  → Atlas (finance)
 *   account_issue                      → Mira (account)
 *
 * Endpoints wrapped:
 *   POST /api/v1/feedback        (create ticket)
 *   GET  /api/v1/feedback/mine   (list current user's tickets)
 *
 * Each helper enforces user_id ownership when inserting (service-role
 * client bypasses RLS, so we set user_id explicitly).
 */

import { SupabaseClient } from '@supabase/supabase-js';

export type FeedbackKind =
  | 'bug'
  | 'ux_issue'
  | 'support_question'
  | 'account_issue'
  | 'marketplace_claim'
  | 'feature_request'
  | 'feedback';

export interface TicketSummary {
  id: string;
  ticket_number: string | number;
  kind: FeedbackKind | string;
  status: string;
  created_at: string;
  raw_text_preview?: string;
}

// ---------------------------------------------------------------------------
// 1-4. submit_*_ticket — kind-specific wrappers around feedback INSERT
// ---------------------------------------------------------------------------

export async function submitTicket(
  sb: SupabaseClient,
  userId: string,
  args: {
    kind: FeedbackKind;
    raw_text: string;
    screen_path?: string;
    structured_fields?: Record<string, unknown>;
  },
): Promise<{ ok: true; ticket: TicketSummary } | { ok: false; error: string }> {
  if (!args.raw_text || args.raw_text.trim().length < 5) {
    return { ok: false, error: 'raw_text_too_short' };
  }
  if (!args.kind) return { ok: false, error: 'kind_required' };

  // Mirror routes/feedback.ts insert shape. resolveVitanaId needs user_id
  // mirroring; if missing, we pass null and the trigger fills it later.
  let vitanaId: string | null = null;
  try {
    const { data: user } = await sb
      .from('app_users')
      .select('vitana_id')
      .eq('user_id', userId)
      .maybeSingle();
    vitanaId = (user as any)?.vitana_id ?? null;
  } catch {
    // ignore — vitana_id resolution is best-effort
  }

  const { data, error } = await sb
    .from('feedback_tickets')
    .insert({
      user_id: userId,
      vitana_id: vitanaId,
      kind: args.kind,
      status: 'new',
      raw_transcript: args.raw_text.trim(),
      raw_text: args.raw_text.trim(),
      structured_fields: args.structured_fields ?? {},
      screen_path: args.screen_path ?? null,
      intake_messages: [],
    })
    .select('id, ticket_number, status, kind, created_at, raw_text')
    .single();
  if (error) {
    return { ok: false, error: `insert_failed: ${error.message}` };
  }

  return {
    ok: true,
    ticket: {
      id: String((data as any).id),
      ticket_number: (data as any).ticket_number ?? (data as any).id,
      kind: String((data as any).kind),
      status: String((data as any).status),
      created_at: String((data as any).created_at),
      raw_text_preview: String((data as any).raw_text ?? '').slice(0, 200),
    },
  };
}

// ---------------------------------------------------------------------------
// 5. list_my_tickets — paginated read of current user's tickets
// ---------------------------------------------------------------------------

export async function listMyTickets(
  sb: SupabaseClient,
  userId: string,
  args: { limit?: number; status?: string },
): Promise<{ ok: true; tickets: TicketSummary[]; count: number } | { ok: false; error: string }> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  let q = sb
    .from('feedback_tickets')
    .select('id, ticket_number, kind, status, created_at, raw_text, raw_transcript')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (args.status) q = q.eq('status', args.status);

  const { data, error } = await q;
  if (error) return { ok: false, error: `tickets_query_failed: ${error.message}` };

  const tickets: TicketSummary[] = (data || []).map((t: any) => ({
    id: String(t.id),
    ticket_number: t.ticket_number ?? t.id,
    kind: String(t.kind),
    status: String(t.status),
    created_at: String(t.created_at),
    raw_text_preview: String(t.raw_text ?? t.raw_transcript ?? '').slice(0, 200),
  }));
  return { ok: true, tickets, count: tickets.length };
}
