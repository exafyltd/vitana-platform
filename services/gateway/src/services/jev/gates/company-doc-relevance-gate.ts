/**
 * VTID-04821: Jev P3 gate E1 — which company document answers a search.
 * (docs/JEV-INTEGRATION-PLAN.md §10.4 E1)
 *
 *   company_doc_relevance   (JEV_COMPANY_DOC_RELEVANCE_MODE = off | shadow | enforce)
 *
 * An Exafy staff member searches the company drives from the Operator
 * Console (dev_company_docs_search). Drive and OneDrive rank by their own
 * full-text match; the first hit is often not the document asked for (an old
 * draft, a copy, a folder).
 *
 * After the search returns, Jev `company_doc_relevance` picks the document
 * that best answers the search (or none) from names, kinds and dates — never
 * file contents, never owners or who it is shared with — under the caller's
 * tenant (business decisions are tenant-scoped; no tenant → skipped). Never
 * awaited; the search result is unchanged. Agreement with the provider's
 * ranking (did Jev pick result 1?) is written at once. Enforce — listing
 * Jev's pick first — comes after the agreement data.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';
import type { CompanyDoc } from '../../company-docs/company-docs';

export const COMPANY_DOC_RELEVANCE_GATE = 'company_doc_relevance';
const SYSTEM_ACTOR = 'company-docs';

export function isCompanyDocRelevanceOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(COMPANY_DOC_RELEVANCE_GATE, env) !== 'off';
}

/** A short kind for a MIME type, so Jev sees "pdf" rather than a vendor string. Pure. */
export function docKind(mime: string | null): string {
  const m = (mime || '').toLowerCase();
  if (!m) return 'unknown';
  if (m === 'folder' || m === 'application/vnd.google-apps.folder') return 'folder';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('google-apps.document') || m.includes('wordprocessingml') || m === 'application/msword') return 'document';
  if (m.includes('google-apps.spreadsheet') || m.includes('spreadsheetml') || m === 'application/vnd.ms-excel' || m === 'text/csv') return 'spreadsheet';
  if (m.includes('google-apps.presentation') || m.includes('presentationml') || m === 'application/vnd.ms-powerpoint') return 'presentation';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

/** What Jev sees: the search and each result's name, kind, date and source, numbered in provider order. Pure. */
export function relevanceInput(query: string, docs: CompanyDoc[]) {
  return {
    query: query.trim().slice(0, 300),
    candidates: docs.slice(0, 10).map((d, i) => ({
      n: i + 1,
      name: (d.name || '(untitled)').slice(0, 300),
      kind: docKind(d.mime),
      modified: d.modified && /^\d{4}-\d{2}-\d{2}/.test(d.modified) ? d.modified.slice(0, 10) : undefined,
      source: d.provider === 'google' ? 'drive' : 'onedrive',
    })),
  };
}

/** After a search with at least one result. Returns the shadow row id or null; never throws. */
export async function runCompanyDocRelevance(a: {
  query: string;
  docs: CompanyDoc[];
  /** The caller's active tenant: business decisions are tenant-scoped (flag and budget). None → skipped. */
  tenantId: string | null;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  now?: () => number;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(COMPANY_DOC_RELEVANCE_GATE, env);
  if (mode === 'off' || !a.tenantId || !a.docs?.length || !a.query?.trim()) return null;
  try {
    const input = relevanceInput(a.query, a.docs);
    const caller = { actor_id: SYSTEM_ACTOR, system: true, system_plane: 'internal' as const, tenant_id: a.tenantId };
    const r = await decide('company_doc_relevance', input, caller, { ...(a.decideOptions || {}), source: `gate:${COMPANY_DOC_RELEVANCE_GATE}`, env });
    const best = r.ok && r.outcome === 'decided' ? String(r.verdict.value) : null;
    const agreed = best === null ? null : best === 'd1';
    return await recordJevShadowDecision(
      {
        gate: COMPANY_DOC_RELEVANCE_GATE,
        decision: 'company_doc_relevance',
        mode,
        plane: 'internal',
        tenant_id: a.tenantId,
        subject_type: 'company_doc_search',
        // The search itself is not stored; a hash groups repeats of the same search.
        subject_ref: createHash('sha256').update(input.query.toLowerCase()).digest('hex').slice(0, 16),
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? { best, probability: r.answers.best?.probability ?? null, results: input.candidates.length, sources: [...new Set(input.candidates.map((c) => c.source))] }
          : { reason: r.reason, results: input.candidates.length },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: 'provider_rank_1',
        cost_usd: r.ok ? r.cost_usd : 0,
        agreed,
        outcome: agreed === null ? null : 'compared_with_provider_ranking',
        outcome_at: agreed === null ? null : new Date((a.now ?? Date.now)()).toISOString(),
      },
      a.sb === undefined ? getSupabase() : a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${COMPANY_DOC_RELEVANCE_GATE} failed: ${err?.message || err}`);
    return null;
  }
}
