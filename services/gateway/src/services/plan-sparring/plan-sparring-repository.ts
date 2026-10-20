/**
 * VTID-04868 — Plan Sparring Gate: data-access seam.
 *
 * Every read/write of the sparring tables goes through here (same
 * client-agnostic shape as the Aurora-migration repositories: the caller
 * passes `sb`). Table/function names are the shared contract:
 *   - public.plan_sparring_sessions     (RLS on, service role only)
 *   - public.plan_sparring_config       (one row, id=1: mode off|log|enforce)
 *   - public.plan_sparring_shadow_log   (written by the vtid_ledger trigger)
 *   - plan_sparring_append_round(p_session uuid, p_round jsonb,
 *     p_expected_round int) — the ONLY way `rounds` grows; the gateway never
 *     UPDATEs or INSERTs `rounds` (service_role has no column privilege on
 *     it; the column default supplies '[]' on create). The RPC raises
 *     SQLSTATE PS409 (round_conflict) when the session moved on underneath
 *     the caller (hardening migration 20261004120000).
 *   - plan_sparring_trigger_status()    — read-only, used by the reconciler
 *     to read pg_trigger.tgenabled (NOT in the P1 contract text; requested
 *     from the DB side, see reconciler.ts).
 *
 * Findings are passed through exactly as the partner submitted them.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ApprovalPolicy,
  ChangeClass,
  ModelLogEntry,
  SparringRound,
  SparringSession,
  SparringVerdict,
  TrustTier,
} from './types';

export interface DbResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

const SESSION_COLUMNS =
  'id, plan_id, plan_hash, final_plan_hash, producer, change_class, trust_tier, base_ref, rounds, verdict, escalation_reasons, model_log, human_approved_by, human_approved_at, approval_evidence, approval_policy, policy_approved_at, policy_approval_rule, vtid, created_at, updated_at';

/**
 * Create a gateway-tier session. `rounds` is deliberately NOT in the payload:
 * service_role holds no INSERT privilege on that column (migration
 * 20261004110000, column-level grants), so naming it — even as `[]` — makes
 * PostgREST's INSERT fail with permission denied. The column default `[]`
 * applies.
 */
export async function insertSession(
  sb: SupabaseClient,
  row: {
    plan_id: string;
    plan_hash: string;
    producer: string;
    change_class: ChangeClass;
    trust_tier: TrustTier;
    base_ref: string;
    approval_policy?: ApprovalPolicy;
  },
): Promise<DbResult<SparringSession>> {
  const r = await sb
    .from('plan_sparring_sessions')
    .insert({ ...row, verdict: 'in_progress', model_log: [], escalation_reasons: [] })
    .select(SESSION_COLUMNS)
    .single();
  return { data: (r.data as SparringSession | null) ?? null, error: r.error ?? null };
}

export async function fetchSession(sb: SupabaseClient, id: string): Promise<DbResult<SparringSession>> {
  const r = await sb.from('plan_sparring_sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle();
  return { data: (r.data as SparringSession | null) ?? null, error: r.error ?? null };
}

/** N7 dedup: the most recent session for this producer + plan hash. */
export async function fetchSessionByPlanHash(
  sb: SupabaseClient,
  producer: string,
  planHash: string,
): Promise<DbResult<SparringSession>> {
  const r = await sb
    .from('plan_sparring_sessions')
    .select(SESSION_COLUMNS)
    .eq('producer', producer)
    .eq('plan_hash', planHash)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return { data: (r.data as SparringSession | null) ?? null, error: r.error ?? null };
}

/** SQLSTATE raised by plan_sparring_append_round on a stale/duplicate append. */
export const ROUND_CONFLICT_SQLSTATE = 'PS409';

export function isRoundConflict(error: { message: string; code?: string } | null | undefined): boolean {
  return Boolean(error) && (error!.code === ROUND_CONFLICT_SQLSTATE || /^round_conflict\b/.test(error!.message ?? ''));
}

/**
 * Append one round — via the append-only RPC, never an UPDATE of `rounds`.
 * `expectedRound` must be the current round count + 1; the RPC checks it under
 * a row lock, so of two racing appends of the same round only one lands. Any
 * RPC error, and any `{ ok: false }` reply (session frozen / not found / bad
 * round), is returned as an error — never treated as a successful append.
 */
export async function appendRound(
  sb: SupabaseClient,
  sessionId: string,
  round: SparringRound,
  expectedRound: number,
): Promise<DbResult<unknown>> {
  const r = await sb.rpc('plan_sparring_append_round', {
    p_session: sessionId,
    p_round: round,
    p_expected_round: expectedRound,
  });
  if (r.error) return { data: null, error: r.error };
  const reply = r.data as { ok?: boolean; error?: string } | null;
  if (reply && typeof reply === 'object' && reply.ok === false) {
    return { data: reply, error: { message: reply.error ?? 'append_round refused', code: reply.error } };
  }
  return { data: r.data ?? null, error: null };
}

/** Non-`rounds` state: verdict, reasons, model log, final hash. */
export async function updateSessionState(
  sb: SupabaseClient,
  sessionId: string,
  patch: {
    verdict?: SparringVerdict;
    escalation_reasons?: string[];
    model_log?: ModelLogEntry[];
    final_plan_hash?: string | null;
  },
): Promise<DbResult<unknown>> {
  const r = await sb
    .from('plan_sparring_sessions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', sessionId);
  return { data: r.data ?? null, error: r.error ?? null };
}

/**
 * Record the verified human approval. Guarded on `human_approved_by IS NULL`
 * so a second approval can never overwrite the first actor.
 */
export async function recordApproval(
  sb: SupabaseClient,
  sessionId: string,
  approval: { human_approved_by: string; human_approved_at: string; approval_evidence: Record<string, unknown> },
): Promise<DbResult<Array<{ id: string }>>> {
  const r = await sb
    .from('plan_sparring_sessions')
    .update({ ...approval, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .is('human_approved_by', null)
    .select('id');
  return { data: (r.data as Array<{ id: string }> | null) ?? null, error: r.error ?? null };
}

/**
 * VTID-05214: record the policy approval of a converged session. Guarded on `policy_approved_at IS NULL`,
 * `human_approved_by IS NULL`, `verdict = 'converged'` and the session's own `approval_policy`; the table CHECK
 * refuses it on anything else as well.
 */
export async function recordPolicyApproval(
  sb: SupabaseClient,
  sessionId: string,
  approval: { rule: ApprovalPolicy; at: string },
): Promise<DbResult<Array<{ id: string }>>> {
  const r = await sb
    .from('plan_sparring_sessions')
    .update({ policy_approved_at: approval.at, policy_approval_rule: approval.rule, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('verdict', 'converged')
    .eq('approval_policy', approval.rule)
    .is('policy_approved_at', null)
    .is('human_approved_by', null)
    .select('id');
  return { data: (r.data as Array<{ id: string }> | null) ?? null, error: r.error ?? null };
}

/**
 * VTID-05254: mark a dead round-1 session (its partner pass died before writing anything) as
 * `escalated` + `deadline_exceeded`, so the create path can re-run the plan on a fresh session.
 * Guarded on `verdict = 'in_progress'`, `updated_at < cutoffIso` and no human/policy approval: of two
 * racing creates only one escalates, and a pass that wrote in the meantime is never overwritten.
 * Writes only columns service_role may UPDATE; `final_plan_hash` stays null, so the row is never approvable.
 */
export async function escalateDeadRoundOne(
  sb: SupabaseClient,
  sessionId: string,
  cutoffIso: string,
): Promise<DbResult<Array<{ id: string }>>> {
  const r = await sb
    .from('plan_sparring_sessions')
    .update({ verdict: 'escalated', escalation_reasons: ['deadline_exceeded'], updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('verdict', 'in_progress')
    .lt('updated_at', cutoffIso)
    .is('human_approved_by', null)
    .is('policy_approved_at', null)
    .select('id');
  return { data: (r.data as Array<{ id: string }> | null) ?? null, error: r.error ?? null };
}

// ---------------------------------------------------------------------------
// Reconciler reads (all read-only)
// ---------------------------------------------------------------------------

export async function fetchConfig(
  sb: SupabaseClient,
): Promise<DbResult<{ id: number; mode: string; updated_at?: string | null }>> {
  const r = await sb.from('plan_sparring_config').select('*').eq('id', 1).maybeSingle();
  return { data: (r.data as { id: number; mode: string; updated_at?: string | null } | null) ?? null, error: r.error ?? null };
}

export interface LedgerRowWithoutSparring {
  id: string;
  vtid: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/** Keyset position: the last row of the previous page. */
export interface LedgerCursor {
  created_at: string;
  id: string;
}

export const LEDGER_PAGE_SIZE = 200;

/**
 * One page of ledger rows created in [sinceIso, untilIso) with no
 * `metadata.sparring_id`, ordered by (created_at, id). Pass the last row of
 * the previous page as `after` to get the next page; a page shorter than
 * `limit` is the last one. Callers page to exhaustion (see reconciler.ts) —
 * a single capped read followed by "advance to now" would skip rows.
 */
export async function fetchLedgerRowsWithoutSparring(
  sb: SupabaseClient,
  sinceIso: string,
  opts: { untilIso?: string; after?: LedgerCursor | null; limit?: number } = {},
): Promise<DbResult<LedgerRowWithoutSparring[]>> {
  let q = sb
    .from('vtid_ledger')
    .select('id, vtid, created_at, metadata')
    .gte('created_at', sinceIso)
    .is('metadata->>sparring_id', null);
  if (opts.untilIso) q = q.lt('created_at', opts.untilIso);
  if (opts.after) {
    const ts = JSON.stringify(opts.after.created_at);
    const id = JSON.stringify(opts.after.id);
    q = q.or(`created_at.gt.${ts},and(created_at.eq.${ts},id.gt.${id})`);
  }
  const r = await q
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(opts.limit ?? LEDGER_PAGE_SIZE);
  return {
    data: (r.data as LedgerRowWithoutSparring[] | null) ?? null,
    error: r.error ?? null,
  };
}

/** Trigger state (pg_trigger.tgenabled) via a read-only RPC. */
export async function fetchTriggerStatus(
  sb: SupabaseClient,
): Promise<DbResult<{ present: boolean; tgenabled: string | null } | Array<{ present: boolean; tgenabled: string | null }>>> {
  const r = await sb.rpc('plan_sparring_trigger_status');
  return { data: r.data ?? null, error: r.error ?? null };
}

/** VTID-05214 reconciler: sessions carrying a policy approval although they are not converged (CHECK tampered). */
export async function fetchPolicyApprovedNonConverged(
  sb: SupabaseClient,
): Promise<DbResult<Array<{ id: string; verdict: string; policy_approval_rule: string | null }>>> {
  const r = await sb
    .from('plan_sparring_sessions')
    .select('id, verdict, policy_approval_rule')
    .not('policy_approved_at', 'is', null)
    .neq('verdict', 'converged')
    .limit(50);
  return { data: (r.data as Array<{ id: string; verdict: string; policy_approval_rule: string | null }> | null) ?? null, error: r.error ?? null };
}
