/**
 * VTID-01976: Intent dispute service (P2-C).
 *
 * Records and resolves disputes raised on intent_matches. Either party
 * of a match can raise; admin tooling resolves. Both vitana_ids are
 * denormalised at insert by the SQL trigger; this service just wraps
 * the CRUD + emits OASIS audit + notifies admin.
 */

import { createClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

export type DisputeReasonCategory = 'no_show' | 'misrepresented' | 'safety' | 'payment' | 'other';

export interface DisputeRow {
  dispute_id: string;
  match_id: string;
  raised_by: string;
  raised_by_vitana_id: string | null;
  counterparty_vitana_id: string | null;
  reason_category: DisputeReasonCategory;
  reason_detail: string;
  status: 'open' | 'investigating' | 'resolved' | 'dismissed' | 'withdrawn';
  resolution: string | null;
  resolution_actor_user_id: string | null;
  resolution_actor_vitana_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface RaiseArgs {
  match_id: string;
  raised_by: string;
  reason_category: DisputeReasonCategory;
  reason_detail: string;
  vitana_id_hint?: string | null; // populated by gateway from req.identity to skip an extra lookup
}

export async function raiseDispute(args: RaiseArgs): Promise<DisputeRow> {
  const supabase = getSupabase();

  // Verify the raiser is one of the parties on the match.
  const { data: m } = await supabase
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, kind_pairing')
    .eq('match_id', args.match_id)
    .maybeSingle();
  if (!m) throw new Error('match_not_found');

  const { data: aOwner } = await supabase
    .from('user_intents')
    .select('requester_user_id')
    .eq('intent_id', (m as any).intent_a_id)
    .maybeSingle();
  const { data: bOwner } = (m as any).intent_b_id
    ? await supabase.from('user_intents').select('requester_user_id').eq('intent_id', (m as any).intent_b_id).maybeSingle()
    : { data: null as any };

  const isParty =
    (aOwner && (aOwner as any).requester_user_id === args.raised_by) ||
    (bOwner && (bOwner as any).requester_user_id === args.raised_by);
  if (!isParty) throw new Error('not_a_party');

  const { data, error } = await supabase
    .from('intent_disputes')
    .insert({
      match_id: args.match_id,
      raised_by: args.raised_by,
      reason_category: args.reason_category,
      reason_detail: args.reason_detail,
      status: 'open',
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  await emitOasisEvent({
    vtid: 'VTID-01976',
    type: 'voice.message.sent', // P2-C reuses an existing audit type; dedicated dispute topic in a follow-up
    source: 'intent-dispute-service',
    status: 'warning',
    message: `intent.dispute.raised — ${args.reason_category}`,
    payload: {
      dispute_id: (data as any).dispute_id,
      match_id: args.match_id,
      reason_category: args.reason_category,
      kind_pairing: (m as any).kind_pairing,
    },
    actor_id: args.raised_by,
    actor_role: 'user',
    surface: 'api',
    vitana_id: args.vitana_id_hint ?? undefined,
  });

  return data as DisputeRow;
}

export async function listDisputesForMatch(matchId: string): Promise<DisputeRow[]> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('intent_disputes')
    .select('*')
    .eq('match_id', matchId)
    .order('created_at', { ascending: false });
  return (data ?? []) as DisputeRow[];
}

interface ResolveArgs {
  dispute_id: string;
  actor_user_id: string;
  actor_vitana_id: string | null;
  status: 'resolved' | 'dismissed';
  resolution: string;
}

export async function resolveDispute(args: ResolveArgs): Promise<DisputeRow> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('intent_disputes')
    .update({
      status: args.status,
      resolution: args.resolution,
      resolution_actor_user_id: args.actor_user_id,
      resolution_actor_vitana_id: args.actor_vitana_id,
      resolved_at: new Date().toISOString(),
    })
    .eq('dispute_id', args.dispute_id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  await emitOasisEvent({
    vtid: 'VTID-01976',
    type: 'voice.message.sent',
    source: 'intent-dispute-service',
    status: args.status === 'resolved' ? 'success' : 'info',
    message: `intent.dispute.${args.status}`,
    payload: {
      dispute_id: args.dispute_id,
      resolution: args.resolution,
    },
    actor_id: args.actor_user_id,
    actor_role: 'admin',
    surface: 'api',
    vitana_id: args.actor_vitana_id ?? undefined,
  });

  return data as DisputeRow;
}

export async function listOpenDisputes(limit = 50): Promise<DisputeRow[]> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('intent_disputes')
    .select('*')
    .in('status', ['open', 'investigating'])
    .order('created_at', { ascending: true })
    .limit(limit);
  return (data ?? []) as DisputeRow[];
}
