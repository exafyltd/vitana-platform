/**
 * VTID-04782: Jev P1 gates E3 + E6 — CRM records as they are created through
 * the Backoffice command path (docs/JEV-INTEGRATION-PLAN.md §10.4 E3, E6).
 *
 *   crm_lead_score              (JEV_CRM_LEAD_SCORE_MODE)              E3
 *   crm_account_classification  (JEV_CRM_ACCOUNT_CLASSIFICATION_MODE)  E6
 *   each = off | shadow | enforce; anything else is off.
 *
 * Business fields only. CRM contacts are personal data (plan §10.4 E): a
 * lead's person name, email, phone, mobile and LinkedIn are never sent, and
 * a customer is only classified when it is explicitly a company — names of
 * people wait for the DPA. The decisions also redact (`pii: 'redact'`).
 *
 * E3: one row per created lead (subject = the ERP lead id). The outcome is
 * written when that lead is converted to an opportunity: a "good fit" or
 * better that converts agrees; a weaker score that converts disagrees.
 * E6: one row per created company/customer. Where the create itself says
 * what kind of account it is (a sales customer, a CRM company created with a
 * lifecycle), agreement is written at once; otherwise it stays null.
 *
 * Fire-and-forget from submitCommand/decideApproval after the command ran:
 * the command, its receipt and its response are unchanged. No enforce
 * behaviour exists yet — that is P2, after the agreement rate is known.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import type { CommandRow } from '../../backoffice/command-store';
import { customerRefOf } from '../../memory/customer';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';

export const CRM_LEAD_SCORE_GATE = 'crm_lead_score';
export const CRM_ACCOUNT_GATE = 'crm_account_classification';
const SYSTEM_ACTOR = 'backoffice-crm';
/** "Good fit" in lead_score's four levels (No / Weak / Good / Strong). */
const GOOD_FIT_LEVEL = 2;
const CONVERT_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;

const str = (v: unknown, max = 300): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null;

function paramsOf(row: Pick<CommandRow, 'payload' | 'resolved_payload'>): Record<string, unknown> {
  return { ...(row.payload || {}), ...(row.resolved_payload || {}) };
}

/** Business fields of a lead, as one line per field. Never the person. */
export const LEAD_BUSINESS_FIELDS = ['company_name', 'industry', 'territory', 'source', 'job_title'] as const;
export function leadBusinessText(row: Pick<CommandRow, 'payload' | 'resolved_payload'>): string | null {
  const p = paramsOf(row);
  const lines = LEAD_BUSINESS_FIELDS.map((f) => [f, str(p[f], 200)] as const).filter(([, v]) => v);
  return lines.length ? lines.map(([f, v]) => `${f.replace(/_/g, ' ')}: ${v}`).join('\n') : null;
}

export interface AccountInput {
  name: string;
  notes: string | null;
  /** The account kind the create action itself implies, if it says one. */
  implied: string | null;
}

const LIFECYCLE_KIND: Record<string, string> = {
  lead: 'prospect', prospect: 'prospect', opportunity: 'prospect',
  customer: 'customer', client: 'customer',
  partner: 'partner', affiliate: 'partner', reseller: 'partner',
  supplier: 'supplier', vendor: 'supplier',
};

/** What to send for an account create, or null when it is not a company. */
export function accountInput(row: Pick<CommandRow, 'type' | 'payload' | 'resolved_payload'>): AccountInput | null {
  const p = paramsOf(row);
  if (row.type === 'crm.company.create') {
    const name = str(p.name) ?? str(p.company_name);
    if (!name) return null;
    const notes = [['industry', str(p.industry, 200)], ['domain', str(p.domain, 200)], ['lifecycle', str(p.lifecycle, 60)], ['description', str(p.description, 1500)]]
      .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') || null;
    const lifecycle = str(p.lifecycle, 60)?.toLowerCase() ?? null;
    return { name, notes, implied: lifecycle ? LIFECYCLE_KIND[lifecycle] ?? null : null };
  }
  if (row.type === 'sales.customer.create') {
    // Only a customer that is explicitly a company: a person's name is personal data.
    if (!/^company$/i.test(str(p.customer_type, 40) ?? '')) return null;
    const name = str(p.name) ?? str(p.customer_name);
    if (!name) return null;
    const notes = [['customer group', str(p.customer_group, 200)], ['description', str(p.description, 1500)]]
      .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') || null;
    return { name, notes, implied: 'customer' };
  }
  return null;
}

export function isCrmGatesOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(CRM_LEAD_SCORE_GATE, env) !== 'off' || jevGateMode(CRM_ACCOUNT_GATE, env) !== 'off';
}

export interface CrmGateOptions {
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
  now?: () => number;
}

function systemCaller(tenantId: string) {
  return { actor_id: SYSTEM_ACTOR, system: true, system_plane: 'internal' as const, tenant_id: tenantId };
}

/**
 * Runs the gate that fits an executed command. Never throws; returns the
 * shadow row id, or null when no gate applied, it was off, or it failed.
 */
export async function runCrmGates(row: CommandRow, opts: CrmGateOptions = {}): Promise<string | null> {
  if (row.status !== 'executed') return null;
  try {
    if (row.type === 'crm.lead.create') return await scoreLead(row, opts);
    if (row.type === 'crm.company.create' || row.type === 'sales.customer.create') return await classifyAccount(row, opts);
    if (row.type === 'crm.lead.convert') {
      await recordLeadConverted(row, opts);
      return null;
    }
    return null;
  } catch (err: any) {
    console.warn(`[jev] CRM gate failed for command ${row.id}: ${err?.message || err}`);
    return null;
  }
}

async function scoreLead(row: CommandRow, opts: CrmGateOptions): Promise<string | null> {
  const env = opts.env ?? process.env;
  const mode = jevGateMode(CRM_LEAD_SCORE_GATE, env);
  if (mode === 'off') return null;
  const lead = leadBusinessText(row);
  if (!lead) return null;
  const ref = customerRefOf(row);
  const subject = ref?.kind === 'lead' && ref.id ? ref.id : `command:${row.id}`;
  const r = await decide('lead_score', { lead }, systemCaller(row.tenant_id), {
    ...(opts.decideOptions || {}), source: `gate:${CRM_LEAD_SCORE_GATE}`, env,
  });
  return recordJevShadowDecision(
    {
      gate: CRM_LEAD_SCORE_GATE,
      decision: 'lead_score',
      mode,
      plane: 'internal',
      tenant_id: row.tenant_id,
      subject_type: 'crm_lead',
      subject_ref: subject,
      jev_outcome: r.outcome,
      jev_verdict: r.ok ? { fit: r.verdict.value, label: r.verdict.label ?? null, command_id: row.id } : { reason: r.reason, command_id: row.id },
      jev_confidence: r.ok ? r.verdict.confidence : null,
      system_action: 'lead_created',
      cost_usd: r.ok ? r.cost_usd : 0,
    },
    opts.sb === undefined ? getSupabase() : opts.sb,
  );
}

async function classifyAccount(row: CommandRow, opts: CrmGateOptions): Promise<string | null> {
  const env = opts.env ?? process.env;
  const mode = jevGateMode(CRM_ACCOUNT_GATE, env);
  if (mode === 'off') return null;
  const input = accountInput(row);
  if (!input) return null;
  const r = await decide('account_classification', { name: input.name, notes: input.notes ?? undefined }, systemCaller(row.tenant_id), {
    ...(opts.decideOptions || {}), source: `gate:${CRM_ACCOUNT_GATE}`, env,
  });
  const kind = r.ok && r.outcome === 'decided' ? String(r.verdict.value) : null;
  const agreed = kind && input.implied ? kind === input.implied : null;
  const ref = customerRefOf(row);
  return recordJevShadowDecision(
    {
      gate: CRM_ACCOUNT_GATE,
      decision: 'account_classification',
      mode,
      plane: 'internal',
      tenant_id: row.tenant_id,
      subject_type: row.type === 'sales.customer.create' ? 'erp_customer' : 'crm_company',
      subject_ref: ref?.id ?? `command:${row.id}`,
      jev_outcome: r.outcome,
      jev_verdict: r.ok ? { kind: r.verdict.value, implied: input.implied, command_id: row.id } : { reason: r.reason, command_id: row.id },
      jev_confidence: r.ok ? r.verdict.confidence : null,
      system_action: input.implied ? `created_as_${input.implied}` : 'created_unspecified',
      agreed,
      outcome: agreed === null ? null : 'compared_with_create_action',
      outcome_at: agreed === null ? null : new Date((opts.now ?? Date.now)()).toISOString(),
      cost_usd: r.ok ? r.cost_usd : 0,
    },
    opts.sb === undefined ? getSupabase() : opts.sb,
  );
}

/** A converted lead: the outcome for its E3 row (if one was recorded). */
async function recordLeadConverted(row: CommandRow, opts: CrmGateOptions): Promise<void> {
  const p = paramsOf(row);
  const leadId = str(p.lead_id, 120);
  if (!leadId) return;
  const sb = opts.sb === undefined ? getSupabase() : opts.sb;
  if (!sb) return;
  const since = new Date((opts.now ?? Date.now)() - CONVERT_LOOKBACK_MS).toISOString();
  const { data, error } = await repo.fetchRecentShadowRow(sb, CRM_LEAD_SCORE_GATE, leadId, since);
  if (error || !data) return;
  const shadow = data as { id: string; jev_outcome: string; jev_verdict: { fit?: number } | null };
  const fit = shadow.jev_outcome === 'decided' && typeof shadow.jev_verdict?.fit === 'number' ? shadow.jev_verdict.fit : null;
  await recordJevShadowOutcome(shadow.id, 'lead_converted', fit === null ? null : fit >= GOOD_FIT_LEVEL, sb);
}
