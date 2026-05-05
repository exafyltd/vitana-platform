/**
 * VTID-02775 — Voice Tool Expansion P1m: Autopilot recommendations.
 *
 * Backs voice tools that drive the autopilot recommendation lifecycle
 * beyond the existing get_recommendations + activate_recommendation +
 * create_index_improvement_plan + ask_pillar_agent primitives.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export async function snoozeRecommendation(
  sb: SupabaseClient,
  userId: string,
  args: { recommendation_id: string; minutes?: number },
): Promise<{ ok: true; recommendation_id: string; snoozed_until: string } | { ok: false; error: string }> {
  if (!args.recommendation_id) return { ok: false, error: 'recommendation_id_required' };
  const minutes = Math.max(15, Math.min(args.minutes ?? 60 * 24, 60 * 24 * 7));
  const snoozedUntil = new Date(Date.now() + minutes * 60_000).toISOString();
  const { error } = await sb
    .from('recommendations')
    .update({ snoozed_until: snoozedUntil, status: 'snoozed' })
    .eq('id', args.recommendation_id)
    .eq('user_id', userId);
  if (error) return { ok: false, error: `snooze_failed: ${error.message}` };
  return { ok: true, recommendation_id: args.recommendation_id, snoozed_until: snoozedUntil };
}

export async function rejectRecommendation(
  sb: SupabaseClient,
  userId: string,
  args: { recommendation_id: string; reason?: string },
): Promise<{ ok: true; recommendation_id: string } | { ok: false; error: string }> {
  if (!args.recommendation_id) return { ok: false, error: 'recommendation_id_required' };
  const { error } = await sb
    .from('recommendations')
    .update({ status: 'rejected', rejected_at: new Date().toISOString(), rejection_reason: args.reason ?? null })
    .eq('id', args.recommendation_id)
    .eq('user_id', userId);
  if (error) return { ok: false, error: `reject_failed: ${error.message}` };
  return { ok: true, recommendation_id: args.recommendation_id };
}

export async function completeRecommendation(
  sb: SupabaseClient,
  userId: string,
  args: { recommendation_id: string; notes?: string },
): Promise<{ ok: true; recommendation_id: string } | { ok: false; error: string }> {
  if (!args.recommendation_id) return { ok: false, error: 'recommendation_id_required' };
  const { error } = await sb
    .from('recommendations')
    .update({ status: 'completed', completed_at: new Date().toISOString(), completion_notes: args.notes ?? null })
    .eq('id', args.recommendation_id)
    .eq('user_id', userId);
  if (error) return { ok: false, error: `complete_failed: ${error.message}` };
  return { ok: true, recommendation_id: args.recommendation_id };
}

export async function explainRecommendation(
  sb: SupabaseClient,
  userId: string,
  args: { recommendation_id: string },
): Promise<
  | { ok: true; recommendation: { id: string; title: string; rationale?: string | null; pillars?: string[] | null; priority?: string | null } }
  | { ok: false; error: string }
> {
  if (!args.recommendation_id) return { ok: false, error: 'recommendation_id_required' };
  const { data, error } = await sb
    .from('recommendations')
    .select('id, title, rationale, contribution_vector, priority, pillars')
    .eq('id', args.recommendation_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { ok: false, error: `explain_failed: ${error.message}` };
  if (!data) return { ok: false, error: 'recommendation_not_found' };
  return {
    ok: true,
    recommendation: {
      id: String((data as any).id),
      title: String((data as any).title ?? ''),
      rationale: (data as any).rationale ?? null,
      pillars: (data as any).pillars ?? null,
      priority: (data as any).priority ?? null,
    },
  };
}

export async function getRecommendationHistory(
  sb: SupabaseClient,
  userId: string,
  args: { limit?: number; status?: string },
): Promise<
  | { ok: true; history: Array<{ id: string; title: string; status: string; updated_at: string }>; count: number }
  | { ok: false; error: string }
> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  let q = sb
    .from('recommendations')
    .select('id, title, status, updated_at, completed_at, rejected_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (args.status) q = q.eq('status', args.status);
  const { data, error } = await q;
  if (error) return { ok: false, error: `history_failed: ${error.message}` };
  const history = (data || []).map((r: any) => ({
    id: String(r.id),
    title: String(r.title ?? ''),
    status: String(r.status ?? ''),
    updated_at: String(r.updated_at ?? ''),
  }));
  return { ok: true, history, count: history.length };
}
