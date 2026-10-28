/**
 * VTID-04822: Jev P3 gate E2 — document type routing for Exafy company
 * documents. (docs/JEV-INTEGRATION-PLAN.md §10.4 E2)
 *
 *   document_type_routing   (JEV_DOCUMENT_TYPE_ROUTING_MODE = off | shadow | enforce)
 *
 * The company documents E1 finds (Exafy Drive / OneDrive) arrive untyped. A
 * contract should go to clause review (E9), an invoice to the payment match
 * (E8), a policy or specification to the knowledge base (E11). Today only a
 * person looking at the name knows which.
 *
 * After a company document search, the top results (folders skipped, at most
 * three, each document at most once a month) are typed by Jev
 * `document_type` from name, kind and source — never contents — under the
 * caller's tenant. The rule next to it is a keyword match on the file name
 * (English, German, Serbian); where the rule names a type, agreement is
 * written at once, otherwise it stays open. Never awaited; the search result
 * is unchanged. Routing a document to its next step is enforce.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';
import type { CompanyDoc } from '../../company-docs/company-docs';
import { docKind } from './company-doc-relevance-gate';

export const DOCUMENT_TYPE_GATE = 'document_type_routing';
const SYSTEM_ACTOR = 'company-docs';
const MAX_DOCS_PER_SEARCH = 3;
const RECLASSIFY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const DOCUMENT_TYPES = [
  'contract', 'invoice', 'quote_or_order', 'policy', 'specification', 'presentation',
  'report', 'legal_corporate', 'hr', 'marketing', 'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Where a document of each type goes next. Pure. */
export const DOCUMENT_ROUTES: Record<DocumentType, string> = {
  contract: 'clause_review',
  invoice: 'payment_match',
  quote_or_order: 'sales',
  policy: 'knowledge_base',
  specification: 'knowledge_base',
  presentation: 'none',
  report: 'none',
  legal_corporate: 'legal_records',
  hr: 'restricted',
  marketing: 'none',
  other: 'none',
};

// First match wins; invoices and quotes before contracts ("Rechnung zum Vertrag" is an invoice).
// German stems are matched inside compounds (Mietvertrag, Eingangsrechnung).
const RULES: Array<[DocumentType, RegExp]> = [
  ['invoice', /\b(invoices?|receipts?|faktur[ae]?|ra[čc]un[ia]?)\b|rechnung|quittung/i],
  ['quote_or_order', /\b(quotes?|quotations?|offers?|ponud[ae]|purchase orders?|porud[žz]bin[ae])\b|angebot|bestellung/i],
  ['contract', /\b(contracts?|agreements?|nda|mou|ugovor[ia]?|sporazum[ia]?)\b|vertrag|vereinbarung/i],
  ['policy', /\b(polic(y|ies)|guidelines?|procedures?|sop|politik[ae]|pravilnik)\b|richtlinie/i],
  ['specification', /\b(specs?|specifications?|requirements|prd|specifikacij[ae])\b|anforderung|lastenheft|pflichtenheft/i],
  ['legal_corporate', /\b(articles of association|shareholders?|power of attorney|statut)\b|satzung|handelsregister|gesellschafter|vollmacht/i],
  ['hr', /\b(cv|resume|payroll|onboarding)\b|lebenslauf|lohnabrechnung|gehaltsabrechnung/i],
  ['report', /\b(reports?|izve[šs]taj[ia]?|analysis)\b|bericht/i],
  ['marketing', /\b(brochures?|flyers?|newsletters?|campaigns?)\b|kampagne|prospekt/i],
];

/** The keyword rule: a type when the file name says so, else null (open). Pure. */
export function ruleDocType(name: string, kind: string): DocumentType | null {
  const n = (name || '').replace(/[_\-.]+/g, ' ');
  for (const [type, re] of RULES) if (re.test(n)) return type;
  if (kind === 'presentation' || /\b(deck|pitch)\b/i.test(n)) return 'presentation';
  return null;
}

export function isDocumentTypeRoutingOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(DOCUMENT_TYPE_GATE, env) !== 'off';
}

/** Type the top results of a search. Returns the rows written; never throws. */
export async function runDocumentTypeRouting(a: {
  docs: CompanyDoc[];
  /** The caller's active tenant: business decisions are tenant-scoped. None → skipped. */
  tenantId: string | null;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  now?: () => number;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string[]> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(DOCUMENT_TYPE_GATE, env);
  if (mode === 'off' || !a.tenantId || !a.docs?.length) return [];
  const sb = a.sb === undefined ? getSupabase() : a.sb;
  const now = (a.now ?? Date.now)();
  const written: string[] = [];
  try {
    const docs = a.docs.filter((d) => d && docKind(d.mime) !== 'folder').slice(0, MAX_DOCS_PER_SEARCH);
    for (const d of docs) {
      const subjectRef = `${d.provider}:${d.id}`.slice(0, 200);
      if (sb) {
        const seen = await repo.fetchRecentShadowBySubject(sb, DOCUMENT_TYPE_GATE, subjectRef, new Date(now - RECLASSIFY_AFTER_MS).toISOString());
        if (!seen.error && seen.data) continue;
      }
      const kind = docKind(d.mime);
      const name = (d.name || '(untitled)').slice(0, 300);
      const rule = ruleDocType(name, kind);
      const caller = { actor_id: SYSTEM_ACTOR, system: true, system_plane: 'internal' as const, tenant_id: a.tenantId };
      const r = await decide('document_type', { name, kind, source: d.provider === 'google' ? 'drive' : 'onedrive' }, caller, { ...(a.decideOptions || {}), source: `gate:${DOCUMENT_TYPE_GATE}`, env });
      const type = r.ok && r.outcome === 'decided' ? (String(r.verdict.value) as DocumentType) : null;
      const agreed = type === null || rule === null ? null : type === rule;
      const id = await recordJevShadowDecision(
        {
          gate: DOCUMENT_TYPE_GATE,
          decision: 'document_type',
          mode,
          plane: 'internal',
          tenant_id: a.tenantId,
          subject_type: 'company_document',
          subject_ref: subjectRef,
          jev_outcome: r.outcome,
          jev_verdict: r.ok
            ? { type, route: type ? DOCUMENT_ROUTES[type] ?? 'none' : null, probability: r.answers.type?.probability ?? null, rule_type: rule, kind }
            : { reason: r.reason, rule_type: rule, kind },
          jev_confidence: r.ok ? r.verdict.confidence : null,
          system_action: rule ? `rule_${rule}` : 'rule_none',
          cost_usd: r.ok ? r.cost_usd : 0,
          agreed,
          outcome: agreed === null ? null : 'compared_with_name_rule',
          outcome_at: agreed === null ? null : new Date(now).toISOString(),
        },
        sb,
      );
      if (id) written.push(id);
    }
  } catch (err: any) {
    console.warn(`[jev] ${DOCUMENT_TYPE_GATE} failed: ${err?.message || err}`);
  }
  return written;
}
