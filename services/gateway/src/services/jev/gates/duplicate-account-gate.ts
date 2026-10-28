/**
 * VTID-04810: Jev P2 gate E5 — duplicate company/customer detection on CRM
 * creates. (docs/JEV-INTEGRATION-PLAN.md §10.4 E5)
 *
 *   crm_duplicate_account   (JEV_CRM_DUPLICATE_ACCOUNT_MODE = off | shadow | enforce)
 *
 * Entity resolution only ever matches a name exactly (VTID-03842), so "Acme
 * GmbH", "ACME" and "Acme Holding GmbH" become three accounts. After a
 * `crm.company.create`, or a `sales.customer.create` that is explicitly a
 * company, the ERP is read through the bridge's own read actions (same
 * allowlist, same tenant routing) for accounts with a similar name. Up to 3
 * company candidates — never a person's record — go to Jev `account_duplicate`
 * with business fields only (name, industry, domain, group, territory). A
 * small rule calls a candidate the same when the names are equal once case,
 * punctuation and legal-form words are removed.
 *
 * One `jev_shadow_decisions` row per create, after the command ran: the
 * command, its receipt and its response are unchanged, nothing is merged or
 * flagged. Agreement is written at once where the rule is certain (an equal
 * normalised name). No enforce behaviour: asking the user before a likely
 * duplicate is created comes after the data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import type { CommandRow } from '../../backoffice/command-store';
import type { ErpBridgeClient } from '../../backoffice/erp-bridge-client';
import { customerRefOf } from '../../memory/customer';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';

export const DUPLICATE_ACCOUNT_GATE = 'crm_duplicate_account';
export const MAX_CANDIDATES = 3;
const SYSTEM_ACTOR = 'backoffice-crm';

const LEGAL_FORMS = new Set([
  'gmbh', 'mbh', 'ag', 'kg', 'ug', 'gbr', 'ohg', 'ev', 'ltd', 'limited', 'llc', 'llp', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'plc', 'sa', 'sas', 'sarl', 'srl', 'spa', 'bv', 'nv', 'doo', 'ad', 'oy', 'ab', 'as', 'aps', 'the',
]);

const str = (v: unknown, max = 300): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null;

/** Lower-case words of a company name without punctuation or legal-form words. */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !LEGAL_FORMS.has(t));
}

export function normalisedName(name: string): string {
  return nameTokens(name).join(' ');
}

/** Word overlap of two names (Jaccard on the normalised words). */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (!ta.size || !tb.size) return 0;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / (ta.size + tb.size - both);
}

export interface NewAccount {
  name: string;
  details: string | null;
  source: 'crm_company' | 'erp_customer';
  created_id: string | null;
}

function params(row: Pick<CommandRow, 'payload' | 'resolved_payload'>): Record<string, unknown> {
  return { ...(row.payload || {}), ...(row.resolved_payload || {}) };
}

const detailsOf = (pairs: Array<[string, unknown]>): string | null =>
  pairs.map(([k, v]) => [k, str(v, 200)] as const).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') || null;

/** The created account, or null when the command is not a company create. */
export function newAccountOf(row: Pick<CommandRow, 'type' | 'payload' | 'resolved_payload' | 'receipt'>): NewAccount | null {
  const p = params(row);
  // The new record's id as the create's receipt returns it (customerRefOf has no company kind).
  const result = ((row.receipt as any)?.result ?? {}) as Record<string, unknown>;
  const created = str(result.id, 120) ?? str(result.name, 120) ?? str(result.company_id, 120) ?? str(result.customer_id, 120) ?? customerRefOf(row as CommandRow)?.id ?? null;
  if (row.type === 'crm.company.create') {
    const name = str(p.name) ?? str(p.company_name);
    if (!name) return null;
    return { name, details: detailsOf([['industry', p.industry], ['domain', p.domain], ['lifecycle', p.lifecycle]]), source: 'crm_company', created_id: created };
  }
  if (row.type === 'sales.customer.create') {
    if (!/^company$/i.test(str(p.customer_type, 40) ?? '')) return null;
    const name = str(p.name) ?? str(p.customer_name);
    if (!name) return null;
    return { name, details: detailsOf([['customer group', p.customer_group], ['territory', p.territory]]), source: 'erp_customer', created_id: created };
  }
  return null;
}

export interface ExistingAccount {
  id: string;
  name: string;
  details: string | null;
}

/** An ERP list record as a company account, or null when it is a person or has no name. */
export function existingAccountOf(r: Record<string, unknown>): ExistingAccount | null {
  const type = str(r.customer_type, 40);
  if (type && !/^company$/i.test(type)) return null;
  const name = str(r.company_name) ?? str(r.customer_name) ?? str(r.name);
  const id = str(r.id, 120) ?? str(r.name, 120);
  if (!name || !id) return null;
  return { id, name, details: detailsOf([['industry', r.industry], ['domain', r.domain ?? r.website], ['customer group', r.customer_group], ['territory', r.territory]]) };
}

const LIST_ACTION: Record<NewAccount['source'], { action: string; listKey: string }> = {
  crm_company: { action: 'list-crm-companies', listKey: 'companies' },
  erp_customer: { action: 'list-customers', listKey: 'customers' },
};

/** Similar existing accounts, most similar first, never the record just created. */
export function similarAccounts(account: NewAccount, records: Array<Record<string, unknown>>): Array<ExistingAccount & { similarity: number; rule_same: boolean }> {
  const want = normalisedName(account.name);
  const out: Array<ExistingAccount & { similarity: number; rule_same: boolean }> = [];
  for (const r of records) {
    const e = existingAccountOf(r);
    if (!e || (account.created_id && (e.id === account.created_id || str(r.name, 120) === account.created_id))) continue;
    const similarity = nameSimilarity(account.name, e.name);
    const rule_same = !!want && normalisedName(e.name) === want;
    if (rule_same || similarity >= 0.5) out.push({ ...e, similarity: Math.round(similarity * 100) / 100, rule_same });
  }
  return out.sort((a, b) => Number(b.rule_same) - Number(a.rule_same) || b.similarity - a.similarity).slice(0, MAX_CANDIDATES);
}

export function isDuplicateAccountOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(DUPLICATE_ACCOUNT_GATE, env) !== 'off';
}

async function listAccounts(bridge: ErpBridgeClient, row: CommandRow, account: NewAccount): Promise<Array<Record<string, unknown>> | null> {
  const spec = LIST_ACTION[account.source];
  const tokens = nameTokens(account.name).sort((a, b) => b.length - a.length);
  const search = tokens[0] && tokens[0].length >= 3 ? tokens[0] : null;
  for (const p of search ? [{ limit: 200, search }, { limit: 200 }] : [{ limit: 200 }]) {
    const res = await bridge.execute({
      tenant_id: row.tenant_id,
      action: spec.action,
      params: p,
      idempotency_key: `jev-dup-${spec.action}-${row.id}-${Object.keys(p).length}`,
      actor: { user_id: row.requester_id, channel: 'system' },
    });
    if (res.ok && res.receipt.status === 'executed') {
      const result = (res.receipt.result ?? {}) as Record<string, unknown>;
      // The named list key, else the first list in the result (ERPClaw module list keys vary).
      const list = Array.isArray(result[spec.listKey]) ? result[spec.listKey] : Object.values(result).find(Array.isArray);
      return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
    }
  }
  return null;
}

/**
 * After an executed company create: look for similar existing accounts and
 * ask Jev about each. Returns the shadow row id, or null when it did not
 * apply, was off, found nothing similar, or failed. Never throws.
 */
export async function runDuplicateAccountCheck(
  row: CommandRow,
  opts: { bridge: ErpBridgeClient | null; env?: NodeJS.ProcessEnv; sb?: SupabaseClient | null; decideOptions?: Omit<DecideOptions, 'source' | 'env'>; now?: () => number },
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const mode = jevGateMode(DUPLICATE_ACCOUNT_GATE, env);
  if (mode === 'off' || row.status !== 'executed' || !opts.bridge) return null;
  try {
    const account = newAccountOf(row);
    if (!account) return null;
    const records = await listAccounts(opts.bridge, row, account);
    if (!records) return null;
    const candidates = similarAccounts(account, records);
    if (candidates.length === 0) return null;
    const caller = { actor_id: SYSTEM_ACTOR, system: true, system_plane: 'internal' as const, tenant_id: row.tenant_id };
    const judged: Array<{ id: string; similarity: number; rule_same: boolean; same: boolean | null; probability: number | null }> = [];
    let cost = 0;
    let outcome = 'fallback';
    let reason: string | undefined;
    for (const c of candidates) {
      const r = await decide(
        'account_duplicate',
        { new_name: account.name, new_details: account.details ?? undefined, existing_name: c.name, existing_details: c.details ?? undefined },
        caller,
        { ...(opts.decideOptions || {}), source: `gate:${DUPLICATE_ACCOUNT_GATE}`, env },
      );
      if (r.ok) { cost += r.cost_usd; if (outcome !== 'decided') outcome = r.outcome; } else reason = r.reason;
      judged.push({ id: c.id, similarity: c.similarity, rule_same: c.rule_same, same: r.ok && r.outcome === 'decided' ? r.verdict.value === true : null, probability: r.ok ? r.answers.same?.probability ?? null : null });
    }
    const ruleSure = judged.filter((j) => j.rule_same);
    const agreed = ruleSure.length && ruleSure.every((j) => j.same !== null) ? ruleSure.every((j) => j.same === true) : null;
    return await recordJevShadowDecision(
      {
        gate: DUPLICATE_ACCOUNT_GATE,
        decision: 'account_duplicate',
        mode,
        plane: 'internal',
        tenant_id: row.tenant_id,
        subject_type: account.source,
        subject_ref: account.created_id ?? `command:${row.id}`,
        jev_outcome: outcome,
        jev_verdict: { candidates: judged, likely_duplicate: judged.some((j) => j.same === true), command_id: row.id, ...(outcome === 'fallback' && reason ? { reason } : {}) },
        jev_confidence: null,
        system_action: 'created',
        cost_usd: cost,
        agreed,
        outcome: agreed === null ? null : 'compared_with_name_rule',
        outcome_at: agreed === null ? null : new Date((opts.now ?? Date.now)()).toISOString(),
      },
      opts.sb === undefined ? getSupabase() : opts.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${DUPLICATE_ACCOUNT_GATE} failed for command ${row.id}: ${err?.message || err}`);
    return null;
  }
}
