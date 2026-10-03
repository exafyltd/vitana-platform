/**
 * VTID-04819: Jev P3 gate E8 — payment ↔ invoice match on an allocation.
 * (docs/JEV-INTEGRATION-PLAN.md §10.4 E8)
 *
 *   payment_invoice_match   (JEV_PAYMENT_INVOICE_MATCH_MODE = off | shadow | enforce)
 *
 * `finance.payment.allocate` (allocate-payment / apply-advance-to-invoice)
 * ties a received payment to an invoice. Entity resolution makes sure both
 * ids exist; nothing checks that they belong together — the right party, a
 * fitting amount, the same currency, an invoice that is still open.
 *
 * After an allocation executes, the payment and the invoice are read through
 * the bridge's own read actions (`get-payment`, `get-sales-invoice`; same
 * allowlist, tenant routing, the requester as actor). Jev
 * `payment_invoice_match` sees amounts, currencies, dates, references and
 * whether the two parties are the same — computed here; a party's name is
 * never sent (customers can be people). A rule is certain when the party or
 * the currency differs (no match) or when party and currency agree and the
 * allocated amount equals the open or total amount (match); agreement is
 * written at once there. One row per allocation; the command is unchanged.
 * Asking before a doubtful allocation is enforce, after the data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import type { CommandRow } from '../../backoffice/command-store';
import type { ErpBridgeClient } from '../../backoffice/erp-bridge-client';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';

export const PAYMENT_MATCH_GATE = 'payment_invoice_match';
const SYSTEM_ACTOR = 'backoffice-finance';
const CENT = 0.01;

type Rec = Record<string, unknown>;
const str = (v: unknown, max = 140): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const first = (r: Rec, keys: string[]): unknown => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null && v !== '');
const foldParty = (v: unknown) => (str(v, 300) ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The ids an allocation command names. */
export function allocationIds(row: Pick<CommandRow, 'payload' | 'resolved_payload'>): { payment_id: string | null; invoice_id: string | null; allocated: number | null } {
  const p = { ...(row.payload || {}), ...(row.resolved_payload || {}) } as Rec;
  return {
    payment_id: str(first(p, ['payment_id', 'payment_entry', 'payment', 'advance_id'])),
    invoice_id: str(first(p, ['invoice_id', 'sales_invoice', 'invoice', 'reference_name'])),
    allocated: num(first(p, ['allocated_amount', 'amount'])),
  };
}

/** A get-* result's record: the named key, else the first object in the result, else the result itself. */
export function recordOf(result: unknown, key: string): Rec | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Rec;
  if (r[key] && typeof r[key] === 'object' && !Array.isArray(r[key])) return r[key] as Rec;
  const obj = Object.values(r).find((v) => v && typeof v === 'object' && !Array.isArray(v));
  return (obj as Rec) ?? r;
}

export interface MatchInput {
  payment_amount: number | null;
  payment_currency?: string;
  payment_date?: string;
  payment_reference?: string;
  allocated_amount: number | null;
  invoice_total: number | null;
  invoice_outstanding_before: number | null;
  invoice_currency?: string;
  invoice_due_date?: string;
  invoice_number?: string;
  same_party: boolean | null;
  reference_mentions_invoice: boolean;
}

/** What Jev sees. Parties are compared here and never sent. Pure. */
export function matchInput(payment: Rec, invoice: Rec, allocated: number | null): MatchInput {
  const payParty = foldParty(first(payment, ['party', 'party_name', 'customer', 'customer_name']));
  const invParty = foldParty(first(invoice, ['customer', 'customer_name', 'party', 'party_name']));
  const reference = str(first(payment, ['reference_no', 'reference', 'remarks_reference']));
  const number = str(first(invoice, ['name', 'invoice_number', 'naming_series', 'id']));
  return {
    payment_amount: num(first(payment, ['paid_amount', 'received_amount', 'amount'])),
    payment_currency: str(first(payment, ['currency', 'paid_from_account_currency', 'paid_to_account_currency']), 10) ?? undefined,
    payment_date: str(first(payment, ['posting_date', 'date']), 20) ?? undefined,
    payment_reference: reference ?? undefined,
    allocated_amount: allocated,
    invoice_total: num(first(invoice, ['grand_total', 'rounded_total', 'total'])),
    invoice_outstanding_before: num(first(invoice, ['outstanding_amount', 'outstanding'])),
    invoice_currency: str(first(invoice, ['currency']), 10) ?? undefined,
    invoice_due_date: str(first(invoice, ['due_date']), 20) ?? undefined,
    invoice_number: number ?? undefined,
    same_party: payParty && invParty ? payParty === invParty : null,
    reference_mentions_invoice: !!(reference && number && reference.toLowerCase().includes(number.toLowerCase())),
  };
}

/** The rule: false on a different party or currency; true when party + currency agree and the amount fits exactly; else null. */
export function ruleMatch(i: MatchInput): boolean | null {
  if (i.same_party === false) return false;
  if (i.payment_currency && i.invoice_currency && i.payment_currency.toUpperCase() !== i.invoice_currency.toUpperCase()) return false;
  const amt = i.allocated_amount ?? i.payment_amount;
  const fits = amt !== null && [i.invoice_outstanding_before, i.invoice_total].some((t) => t !== null && Math.abs(t - amt) < CENT);
  return i.same_party === true && fits ? true : null;
}

export function isPaymentMatchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(PAYMENT_MATCH_GATE, env) !== 'off';
}

async function read(bridge: ErpBridgeClient, row: CommandRow, action: string, params: Rec): Promise<unknown | null> {
  const res = await bridge.execute({
    tenant_id: row.tenant_id,
    action,
    params,
    idempotency_key: `jev-match-${action}-${row.id}`,
    actor: { user_id: row.requester_id, channel: 'system' },
  });
  return res.ok && res.receipt.status === 'executed' ? res.receipt.result ?? null : null;
}

/** After an executed allocation. Returns the shadow row id or null; never throws. */
export async function runPaymentMatchCheck(
  row: CommandRow,
  opts: { bridge: ErpBridgeClient | null; env?: NodeJS.ProcessEnv; sb?: SupabaseClient | null; decideOptions?: Omit<DecideOptions, 'source' | 'env'>; now?: () => number },
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const mode = jevGateMode(PAYMENT_MATCH_GATE, env);
  if (mode === 'off' || row.status !== 'executed' || row.type !== 'finance.payment.allocate' || !opts.bridge) return null;
  try {
    const ids = allocationIds(row);
    if (!ids.payment_id || !ids.invoice_id) return null;
    const [payRes, invRes] = await Promise.all([
      read(opts.bridge, row, 'get-payment', { payment_id: ids.payment_id }),
      read(opts.bridge, row, 'get-sales-invoice', { invoice_id: ids.invoice_id }),
    ]);
    const payment = recordOf(payRes, 'payment');
    const invoice = recordOf(invRes, 'invoice');
    if (!payment || !invoice) return null;
    const input = matchInput(payment, invoice, ids.allocated);
    const rule = ruleMatch(input);
    const caller = { actor_id: SYSTEM_ACTOR, system: true, system_plane: 'internal' as const, tenant_id: row.tenant_id };
    const r = await decide('payment_invoice_match', { ...input }, caller, { ...(opts.decideOptions || {}), source: `gate:${PAYMENT_MATCH_GATE}`, env });
    const matches = r.ok && r.outcome === 'decided' ? r.verdict.value === true : null;
    const agreed = matches === null || rule === null ? null : matches === rule;
    return await recordJevShadowDecision(
      {
        gate: PAYMENT_MATCH_GATE,
        decision: 'payment_invoice_match',
        mode,
        plane: 'internal',
        tenant_id: row.tenant_id,
        subject_type: 'erp_payment_allocation',
        subject_ref: `${ids.payment_id}->${ids.invoice_id}`.slice(0, 280),
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? { matches, probability: r.answers.matches?.probability ?? null, issue: r.answers.issue?.value ?? null, rule, same_party: input.same_party, command_id: row.id }
          : { reason: r.reason, rule, same_party: input.same_party, command_id: row.id },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: 'allocated',
        cost_usd: r.ok ? r.cost_usd : 0,
        agreed,
        outcome: agreed === null ? null : 'compared_with_match_rule',
        outcome_at: agreed === null ? null : new Date((opts.now ?? Date.now)()).toISOString(),
      },
      opts.sb === undefined ? getSupabase() : opts.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${PAYMENT_MATCH_GATE} failed for command ${row.id}: ${err?.message || err}`);
    return null;
  }
}
