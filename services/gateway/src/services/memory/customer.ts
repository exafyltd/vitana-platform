/**
 * VTID-04411 — customer-scoped memory for the BackOffice.
 *
 * Write: every executed BackOffice CRM/sales command that is about a
 * customer, lead, contact or opportunity leaves one `customer` episode in
 * memory_items. Recall: the BackOffice assistant asks for everything the team
 * recorded about one customer (`backoffice_customer_memory` voice tool).
 *
 * Scope rules:
 *   - the row belongs to the tenant; `user_id` is the staff member who ran the
 *     command, `active_role` is 'backoffice', so personal recall and the
 *     Memory Garden (which read community/NULL roles) never show it;
 *   - recall is tenant-wide by `content_json.customer_key`, because customer
 *     knowledge is the team's, not one person's; the caller must hold
 *     crm.view or sales.view (or be an Exafy admin);
 *   - one row per command (unique index on command_id), importance 40, so
 *     trg_notify_memory_garden (> 50) never fires.
 *
 * The episode text is built from the command's own fields — no model call —
 * so it is deterministic, cheap, and never invents anything.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CommandRow } from '../backoffice/command-store';
import { embedItemLater } from './embed-item';

export const CUSTOMER_MEMORY_COMMANDS: ReadonlySet<string> = new Set([
  'crm.activity.create',
  'crm.task.create', 'crm.task.complete',
  'crm.lead.create', 'crm.lead.update', 'crm.lead.convert',
  'crm.contact.create', 'crm.contact.update', 'crm.contact.promote_to_customer',
  'crm.opportunity.create', 'crm.opportunity.update', 'crm.opportunity.mark_won', 'crm.opportunity.mark_lost',
  'sales.customer.create', 'sales.customer.update', 'sales.customer.hold_release',
  'sales.quotation.create', 'sales.invoice.create', 'sales.credit_note.create',
]);

export const CUSTOMER_EPISODE_IMPORTANCE = 40;
export const CUSTOMER_EPISODE_MAX_CHARS = 1_200;

/** Fields whose text says what happened, in the order they are quoted. */
const TEXT_FIELDS = ['subject', 'summary', 'title', 'activity_type', 'description', 'notes', 'note', 'status', 'reason', 'lost_reason', 'stage'];
const ID_FIELDS: Array<[string, string]> = [
  ['customer_id', 'customer'], ['lead_id', 'lead'], ['contact_id', 'contact'], ['opportunity_id', 'opportunity'],
];
const LABEL_FIELDS = ['customer_ref', 'customer_name', 'lead_ref', 'lead_name', 'contact_name', 'opportunity_ref', 'opportunity_name', 'company_name', 'name'];

export interface CustomerRef {
  /** stable key, e.g. `customer:CUST-0001`, or `name:acme gmbh` when no id is known */
  key: string;
  kind: string;
  id: string | null;
  label: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
export const foldName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Which customer a command is about: a resolved id first, then the receipt, then a name. */
export function customerRefOf(row: Pick<CommandRow, 'type' | 'payload' | 'resolved_payload' | 'receipt'>): CustomerRef | null {
  const p = { ...(row.payload || {}), ...(row.resolved_payload || {}) } as Record<string, unknown>;
  const result = ((row.receipt as any)?.result ?? row.receipt ?? {}) as Record<string, unknown>;
  const label = LABEL_FIELDS.map((f) => str(p[f]) ?? str(result[f])).find(Boolean) ?? null;
  for (const [field, kind] of ID_FIELDS) {
    const id = str(p[field]) ?? str(result[field]);
    if (id) return { key: `${kind}:${id}`, kind, id, label };
  }
  // A create returns the new record's id as the result's own id/name.
  const created = row.type.split('.')[1];
  const kindForCreate: Record<string, string> = { customer: 'customer', lead: 'lead', contact: 'contact', opportunity: 'opportunity' };
  if (kindForCreate[created]) {
    const id = str(result.id) ?? str(result.name);
    if (id) return { key: `${kindForCreate[created]}:${id}`, kind: kindForCreate[created], id, label };
  }
  if (label) return { key: `name:${foldName(label)}`, kind: 'name', id: null, label };
  return null;
}

/** One line per command, from its own fields; English labels, the user's data verbatim. */
export function describeCommand(row: Pick<CommandRow, 'type' | 'payload' | 'resolved_payload'>, ref: CustomerRef): string {
  const p = { ...(row.payload || {}), ...(row.resolved_payload || {}) } as Record<string, unknown>;
  const who = ref.label ? `${ref.label}${ref.id ? ` (${ref.id})` : ''}` : ref.id ?? ref.key;
  const details = TEXT_FIELDS
    .map((f) => [f, str(p[f])] as const)
    .filter(([, v]) => v)
    .map(([f, v]) => `${f.replace(/_/g, ' ')}: ${v!.replace(/\s+/g, ' ')}`);
  const text = `${row.type} — ${who}${details.length ? ` — ${details.join('; ')}` : ''}`;
  return text.length > CUSTOMER_EPISODE_MAX_CHARS ? `${text.slice(0, CUSTOMER_EPISODE_MAX_CHARS - 1)}…` : text;
}

export type CustomerEpisodeOutcome =
  | { status: 'written'; id: string | null }
  | { status: 'not_applicable' | 'no_customer' | 'already_written' }
  | { status: 'write_failed'; error: string };

/** Record one executed command as a customer episode. Never throws. */
export async function recordCustomerEpisode(sb: SupabaseClient, row: CommandRow): Promise<CustomerEpisodeOutcome> {
  try {
    if (row.status !== 'executed' || !CUSTOMER_MEMORY_COMMANDS.has(row.type)) return { status: 'not_applicable' };
    const ref = customerRefOf(row);
    if (!ref) return { status: 'no_customer' };
    const content = describeCommand(row, ref);
    const { data, error } = await sb
      .from('memory_items')
      .insert({
        tenant_id: row.tenant_id,
        user_id: row.requester_id,
        category_key: 'customer',
        source: 'system',
        content,
        content_json: {
          kind: 'customer',
          customer_key: ref.key,
          customer_kind: ref.kind,
          customer_id: ref.id,
          customer_label: ref.label ? foldName(ref.label) : null,
          command_id: row.id,
          command_type: row.type,
          channel: row.channel,
        },
        importance: CUSTOMER_EPISODE_IMPORTANCE,
        active_role: 'backoffice',
        occurred_at: row.executed_at || new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) {
      if (/duplicate key|23505/i.test(error.message)) return { status: 'already_written' };
      return { status: 'write_failed', error: error.message };
    }
    void embedItemLater((data as any)?.id, content);
    return { status: 'written', id: (data as any)?.id ?? null };
  } catch (err) {
    return { status: 'write_failed', error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CustomerMemoryEntry {
  id: string;
  content: string;
  command_type: string | null;
  customer_key: string | null;
  occurred_at: string;
}

/**
 * Everything recorded for one customer in a tenant, newest first. `ref` is an
 * id (`CUST-0001`), a key (`customer:CUST-0001`) or a name; a name matches the
 * folded label exactly, never a prefix, so two similarly named customers
 * never mix.
 */
export async function recallCustomerMemory(
  sb: SupabaseClient,
  tenantId: string,
  ref: string,
  opts: { limit?: number } = {},
): Promise<CustomerMemoryEntry[]> {
  const r = ref.trim();
  if (!r) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50));
  const keys = r.includes(':') ? [r] : [...ID_FIELDS.map(([, kind]) => `${kind}:${r}`), `name:${foldName(r)}`];
  const quoted = (v: string) => `"${v.replace(/"/g, '\\"')}"`;
  const or = [
    `content_json->>customer_key.in.(${keys.map(quoted).join(',')})`,
    `content_json->>customer_label.eq.${quoted(foldName(r))}`,
  ].join(',');
  const { data, error } = await sb
    .from('memory_items')
    .select('id, content, content_json, occurred_at')
    .eq('tenant_id', tenantId)
    .eq('category_key', 'customer')
    .or(or)
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data as any[]) || []).map((d) => ({
    id: d.id,
    content: d.content,
    command_type: d.content_json?.command_type ?? null,
    customer_key: d.content_json?.customer_key ?? null,
    occurred_at: d.occurred_at,
  }));
}
