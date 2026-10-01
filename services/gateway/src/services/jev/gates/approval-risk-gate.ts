/**
 * VTID-04811: Jev P2 gate E7 — risk hint for a queued High-risk Backoffice
 * command. (docs/JEV-INTEGRATION-PLAN.md §10.4 E7)
 *
 *   approval_risk   (JEV_APPROVAL_RISK_MODE = off | shadow | enforce)
 *
 * A High-risk command (cancelling an invoice or a payment, a payment above the
 * tenant's threshold, …) waits for a second person with the approve
 * capability. The approver sees the command; nothing says whether it looks
 * routine or wrong.
 *
 * When a command is queued, Jev `approval_risk` scores it (routine / some
 * risk / high risk / looks wrong) from the command type and action, the
 * escalations that made it High, an allow-list of business fields (amount,
 * currency, kind, dates, references, item count) and the names — not the
 * values — of the other payload fields. Payroll-tagged commands are never
 * sent (salaries are personal data). Never awaited; the queue, the approval
 * and the response are unchanged and nothing is shown to the approver yet.
 *
 * One `jev_shadow_decisions` row per approval. When the approver decides,
 * the row records it: "high risk" or worse agrees with a rejection, anything
 * lower agrees with an approval. Showing the hint to approvers is enforce,
 * after the data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import type { CommandRow } from '../../backoffice/command-store';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';

export const APPROVAL_RISK_GATE = 'approval_risk';
/** "High risk, check carefully" in approval_risk's four levels. */
export const HIGH_RISK_LEVEL = 2;
const SYSTEM_ACTOR = 'backoffice-approvals';
const DECIDE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/** Business fields whose VALUES may be sent. Everything else is sent by name only. */
export const VALUE_FIELDS = [
  'amount', 'currency', 'kind', 'payment_type', 'mode_of_payment', 'posting_date', 'due_date',
  'reference_type', 'reference_name', 'invoice_id', 'payment_id', 'company', 'cost_center', 'account_number',
] as const;

const str = (v: unknown, max = 120): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

export interface ApprovalRiskInput {
  command_type: string;
  action: string;
  escalations: string[];
  fields: string;
  payload_keys: string[];
}

/** What to send for a queued command, or null when it must not be sent (payroll). */
export function approvalRiskInput(row: Pick<CommandRow, 'type' | 'action' | 'payload' | 'resolved_payload' | 'escalations'>): ApprovalRiskInput | null {
  const p = { ...(row.payload || {}), ...(row.resolved_payload || {}) } as Record<string, unknown>;
  const tags = Array.isArray(p.tags) ? p.tags.map(String) : [];
  if (tags.includes('payroll') || (row.escalations || []).some((e) => /payroll/i.test(e))) return null;
  const lines = VALUE_FIELDS.map((f) => [f, str(p[f])] as const).filter(([, v]) => v).map(([f, v]) => `${f.replace(/_/g, ' ')}: ${v}`);
  for (const listKey of ['items', 'lines', 'allocations', 'accounts']) {
    if (Array.isArray(p[listKey])) lines.push(`${listKey}: ${(p[listKey] as unknown[]).length}`);
  }
  return {
    command_type: row.type,
    action: row.action,
    escalations: (row.escalations || []).slice(0, 10),
    fields: lines.join('\n') || '(no business fields)',
    payload_keys: Object.keys(p).sort().slice(0, 60),
  };
}

export function isApprovalRiskOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(APPROVAL_RISK_GATE, env) !== 'off';
}

/** Score a queued command. Returns the shadow row id or null; never throws. */
export async function runApprovalRiskCheck(
  row: CommandRow,
  approvalId: string,
  opts: { env?: NodeJS.ProcessEnv; sb?: SupabaseClient | null; decideOptions?: Omit<DecideOptions, 'source' | 'env'> } = {},
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const mode = jevGateMode(APPROVAL_RISK_GATE, env);
  if (mode === 'off' || row.status !== 'awaiting_approval') return null;
  try {
    const input = approvalRiskInput(row);
    if (!input) return null;
    const caller = { actor_id: SYSTEM_ACTOR, system: true, system_plane: 'internal' as const, tenant_id: row.tenant_id };
    const r = await decide('approval_risk', { ...input }, caller, { ...(opts.decideOptions || {}), source: `gate:${APPROVAL_RISK_GATE}`, env });
    return await recordJevShadowDecision(
      {
        gate: APPROVAL_RISK_GATE,
        decision: 'approval_risk',
        mode,
        plane: 'internal',
        tenant_id: row.tenant_id,
        subject_type: 'backoffice_approval',
        subject_ref: approvalId,
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? { level: r.outcome === 'decided' ? r.verdict.value : null, label: r.verdict.label ?? null, command_id: row.id, command_type: row.type, escalations: input.escalations }
          : { reason: r.reason, command_id: row.id, command_type: row.type },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: 'queued_for_approval',
        cost_usd: r.ok ? r.cost_usd : 0,
      },
      opts.sb === undefined ? getSupabase() : opts.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${APPROVAL_RISK_GATE} failed for command ${row.id}: ${err?.message || err}`);
    return null;
  }
}

/** The approver decided: the outcome for the approval's row, if one was written. Never throws. */
export async function recordApprovalDecision(
  approvalId: string,
  verdict: 'approved' | 'rejected',
  opts: { sb?: SupabaseClient | null; now?: () => number } = {},
): Promise<void> {
  try {
    const sb = opts.sb === undefined ? getSupabase() : opts.sb;
    if (!sb) return;
    const since = new Date((opts.now ?? Date.now)() - DECIDE_LOOKBACK_MS).toISOString();
    const { data, error } = await repo.fetchRecentShadowRow(sb, APPROVAL_RISK_GATE, approvalId, since);
    if (error || !data) return;
    const row = data as { id: string; jev_outcome?: string; jev_verdict?: { level?: unknown } };
    const level = row.jev_outcome === 'decided' && typeof row.jev_verdict?.level === 'number' ? row.jev_verdict.level : null;
    const agreed = level === null ? null : (level >= HIGH_RISK_LEVEL) === (verdict === 'rejected');
    await recordJevShadowOutcome(row.id, `approver_${verdict}`, agreed, sb);
  } catch (err: any) {
    console.warn(`[jev] ${APPROVAL_RISK_GATE} outcome not recorded for ${approvalId}: ${err?.message || err}`);
  }
}
