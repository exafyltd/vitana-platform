/**
 * VTID-04820: Jev P3 gate E10 — partner onboarding triage on submit
 * (advisory). (docs/JEV-INTEGRATION-PLAN.md §10.4 E10)
 *
 *   partner_onboarding_triage   (JEV_PARTNER_ONBOARDING_TRIAGE_MODE = off | shadow | enforce)
 *
 * When a partner submits its onboarding, the rules decide: every required
 * checklist step done → live, otherwise needs_action. They check that each
 * step is done, not whether the whole application hangs together — a legal
 * name that does not fit the website, a regulated vertical, a catalogue that
 * exists on paper only.
 *
 * After submit's state moves, Jev `partner_onboarding_triage` judges the
 * application (ready? main concern) from business facts — partner type,
 * vertical, legal name, country, website host, whether a VAT id is present —
 * and the checklist (step, required, status, missing codes), next to the
 * rules' outcome, under the submitting user's active tenant (business
 * decisions are tenant-scoped; no tenant → skipped). Never contact persons
 * or member data; never awaited; the
 * submit, its moves and its response are unchanged. Agreement with the rules
 * is written at once. Showing the triage to the reviewer is enforce; KYB and
 * approval stay human (plan §10.4 A3 note, VCAOP human gate).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision } from '../jev-shadow';

export const PARTNER_TRIAGE_GATE = 'partner_onboarding_triage';
const SYSTEM_ACTOR = 'partner-onboarding';

export interface TriageOrg {
  id: string;
  partner_type: string | null;
  commerce_vertical: string | null;
  legal_name: string | null;
  country: string | null;
  vat_id: string | null;
  website: string | null;
}

export interface TriageStep {
  key: string;
  required: boolean;
  status: string;
  missing?: string[];
}

export function isPartnerTriageOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(PARTNER_TRIAGE_GATE, env) !== 'off';
}

function hostOf(website: string | null): string | undefined {
  if (!website) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.slice(0, 200) || undefined;
  } catch {
    return undefined;
  }
}

/** What Jev sees: business facts and the checklist. Never the VAT number itself, owners or members. Pure. */
export function triageInput(org: TriageOrg, steps: TriageStep[], verificationLevel: number, rulesOutcome: string) {
  return {
    partner_type: (org.partner_type || 'unknown').slice(0, 40),
    commerce_vertical: org.commerce_vertical?.slice(0, 60) || undefined,
    legal_name: org.legal_name?.slice(0, 200) || undefined,
    country: org.country?.slice(0, 2).toUpperCase() || undefined,
    website_host: hostOf(org.website),
    has_vat_id: !!(org.vat_id && org.vat_id.trim()),
    verification_level_required: Math.max(0, Math.min(2, Math.floor(verificationLevel || 0))),
    steps: steps.slice(0, 20).map((s) => ({ key: String(s.key).slice(0, 60), required: !!s.required, status: String(s.status).slice(0, 20), missing: (s.missing || []).slice(0, 10).map((m) => String(m).slice(0, 60)) })),
    rules_outcome: rulesOutcome.slice(0, 20),
  };
}

/** After submit. Returns the shadow row id or null; never throws. */
export async function runPartnerTriage(a: {
  org: TriageOrg;
  /** The submitting user's active tenant: business decisions are tenant-scoped (flag and budget). None → skipped. */
  tenantId: string | null;
  steps: TriageStep[];
  verificationLevel: number;
  rulesOutcome: 'live' | 'needs_action';
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  now?: () => number;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(PARTNER_TRIAGE_GATE, env);
  if (mode === 'off' || !a.tenantId) return null;
  try {
    const input = triageInput(a.org, a.steps, a.verificationLevel, a.rulesOutcome);
    const caller = { actor_id: SYSTEM_ACTOR, system: true, system_plane: 'internal' as const, tenant_id: a.tenantId };
    const r = await decide('partner_onboarding_triage', input, caller, { ...(a.decideOptions || {}), source: `gate:${PARTNER_TRIAGE_GATE}`, env });
    const ready = r.ok && r.outcome === 'decided' ? r.verdict.value === true : null;
    const agreed = ready === null ? null : ready === (a.rulesOutcome === 'live');
    return await recordJevShadowDecision(
      {
        gate: PARTNER_TRIAGE_GATE,
        decision: 'partner_onboarding_triage',
        mode,
        plane: 'internal',
        tenant_id: a.tenantId,
        subject_type: 'partner_organization',
        subject_ref: a.org.id,
        jev_outcome: r.outcome,
        jev_verdict: r.ok
          ? { ready, probability: r.answers.ready?.probability ?? null, concern: r.answers.concern?.value ?? null, rules_outcome: a.rulesOutcome, partner_type: input.partner_type }
          : { reason: r.reason, rules_outcome: a.rulesOutcome, partner_type: input.partner_type },
        jev_confidence: r.ok ? r.verdict.confidence : null,
        system_action: `submit_${a.rulesOutcome}`,
        cost_usd: r.ok ? r.cost_usd : 0,
        agreed,
        outcome: agreed === null ? null : 'compared_with_checklist_rules',
        outcome_at: agreed === null ? null : new Date((a.now ?? Date.now)()).toISOString(),
      },
      a.sb === undefined ? getSupabase() : a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${PARTNER_TRIAGE_GATE} failed for ${a.org?.id}: ${err?.message || err}`);
    return null;
  }
}
