/**
 * VTID-03842 — entity resolution: exact match only, never a guess.
 *
 * Mirrors ERPClaw's own SKILL.md rule ("refuse to guess"): a payload may name
 * an entity by a human reference (`customer_ref: "Acme LLC"`, `account_ref:
 * "1110"`, `lead_ref: "…"`) and the orchestrator turns it into the id the
 * ERPClaw action needs — but ONLY when exactly one record matches exactly
 * (after trimming and case folding). Zero or several matches reject the
 * command with `entity_not_found` / `entity_ambiguous` and the candidates,
 * so the user picks; nothing is ever posted against a "closest" match.
 *
 * Lookups go through the bridge's Read actions (same allowlist, same tenant
 * routing) — there is no second path into the ERP database.
 */
import type { ErpBridgeClient } from './erp-bridge-client';

export interface RefSpec {
  /** payload key holding the human reference */
  refField: string;
  /** payload key that receives the resolved id */
  idField: string;
  /** bridge Read action that lists candidates */
  action: string;
  /** key of the list in the action's result */
  listKey: string;
  /** record fields compared for an exact (trimmed, case-folded) match */
  matchFields: readonly string[];
  /** extra list params (e.g. a bounded limit) */
  params?: Record<string, unknown>;
  /** list-action param that narrows candidates server-side (ERPClaw `--search`, a LIKE); exact match is still applied here */
  searchParam?: string;
}

export const REF_SPECS: readonly RefSpec[] = [
  { refField: 'customer_ref', idField: 'customer_id', action: 'list-customers', listKey: 'customers', matchFields: ['customer_name', 'name', 'naming_series'], params: { limit: 200 }, searchParam: 'search' },
  { refField: 'account_ref', idField: 'account_id', action: 'list-accounts', listKey: 'accounts', matchFields: ['account_number', 'name'], params: { limit: 200 }, searchParam: 'search' },
  { refField: 'lead_ref', idField: 'lead_id', action: 'list-leads', listKey: 'leads', matchFields: ['lead_name', 'naming_series', 'email'], params: { limit: 200 }, searchParam: 'search' },
  { refField: 'opportunity_ref', idField: 'opportunity_id', action: 'list-opportunities', listKey: 'opportunities', matchFields: ['opportunity_name', 'naming_series'], params: { limit: 200 }, searchParam: 'search' },
  { refField: 'tax_template_ref', idField: 'tax_template_id', action: 'list-tax-templates', listKey: 'templates', matchFields: ['name'], params: { limit: 200 } },
  { refField: 'cost_center_ref', idField: 'cost_center_id', action: 'list-cost-centers', listKey: 'cost_centers', matchFields: ['name'], params: { limit: 500 } },
];

export type ResolutionResult =
  | { ok: true; payload: Record<string, unknown>; resolved: Array<{ field: string; ref: string; id: string }> }
  | { ok: false; reason: 'entity_not_found' | 'entity_ambiguous' | 'entity_lookup_failed' | 'entity_ref_conflict'; field: string; ref: string; candidates?: Array<Record<string, unknown>>; error?: string };

const fold = (v: unknown) => String(v ?? '').trim().toLowerCase();

export function pickExact(records: Array<Record<string, unknown>>, ref: string, matchFields: readonly string[]): Array<Record<string, unknown>> {
  const want = fold(ref);
  if (!want) return [];
  return records.filter((r) => matchFields.some((f) => fold(r[f]) === want));
}

export async function resolveEntities(
  bridge: ErpBridgeClient,
  tenantId: string,
  actorUserId: string,
  payload: Record<string, unknown>,
  specs: readonly RefSpec[] = REF_SPECS,
): Promise<ResolutionResult> {
  const out: Record<string, unknown> = { ...payload };
  const resolved: Array<{ field: string; ref: string; id: string }> = [];
  for (const spec of specs) {
    const ref = payload[spec.refField];
    if (ref === undefined || ref === null || ref === '') continue;
    if (typeof ref !== 'string') return { ok: false, reason: 'entity_not_found', field: spec.refField, ref: String(ref) };
    if (payload[spec.idField] !== undefined && payload[spec.idField] !== null && payload[spec.idField] !== '') {
      // Both a ref and an id given: refuse rather than silently prefer one.
      return { ok: false, reason: 'entity_ref_conflict', field: spec.refField, ref };
    }
    const res = await bridge.execute({
      tenant_id: tenantId,
      action: spec.action,
      params: { ...(spec.params ?? {}), ...(spec.searchParam ? { [spec.searchParam]: ref.trim() } : {}) },
      idempotency_key: `lookup-${spec.action}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      actor: { user_id: actorUserId, channel: 'system' },
    });
    if (!res.ok || res.receipt.status !== 'executed') {
      return { ok: false, reason: 'entity_lookup_failed', field: spec.refField, ref, error: res.ok ? 'bridge_action_failed' : res.error };
    }
    const result = (res.receipt.result ?? {}) as Record<string, unknown>;
    const records = Array.isArray(result[spec.listKey]) ? (result[spec.listKey] as Array<Record<string, unknown>>) : [];
    const matches = pickExact(records, ref, spec.matchFields);
    if (matches.length === 0) return { ok: false, reason: 'entity_not_found', field: spec.refField, ref };
    if (matches.length > 1) return { ok: false, reason: 'entity_ambiguous', field: spec.refField, ref, candidates: matches.slice(0, 10).map((m) => ({ id: m.id, ...Object.fromEntries(spec.matchFields.map((f) => [f, m[f]])) })) };
    const id = String(matches[0].id);
    out[spec.idField] = id;
    delete out[spec.refField];
    resolved.push({ field: spec.idField, ref, id });
  }
  return { ok: true, payload: out, resolved };
}
