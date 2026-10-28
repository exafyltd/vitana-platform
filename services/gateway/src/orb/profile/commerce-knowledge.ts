/**
 * VTID-04844 — what the commerce Vitana knows about THIS supplier when the
 * session opens: their businesses on Vitanaland, the setup state of each
 * and the steps still open. It is what lets her guide ("your company details
 * are complete; next is verification") instead of asking what she could read.
 *
 * Read-only, the caller's own memberships only, and the same checklist code
 * the portal shows (routes/partner-onboarding.ts loadChecklist). Fails open:
 * no data means a generic opener, never a blocked session.
 */
import type { WorkSurfaceKnowledge } from './work-surface-context';

const MAX_ORGS = 3;

/** Plain words for the checklist steps (prompt text, English — §13b). */
const STEP_LABEL: Record<string, string> = {
  account: 'account',
  company: 'company details',
  verification: 'verification',
  catalogue: 'products or services',
  mapping: 'catalogue mapping (one complete offering, or a connected shop)', // VTID-04953
  tracking_test: 'tracking test',
  results_channel: 'results channel',
  terms: 'partner terms',
  dpa: 'data processing agreement',
  billing_mandate: 'billing mandate',
  team: 'team',
};

const STATE_LABEL: Record<string, string> = {
  draft: 'setting up (not yet submitted)',
  submitted: 'submitted, checks starting',
  verifying: 'being verified',
  needs_action: 'needs something from the supplier',
  exception: 'with the Vitanaland team for a manual look',
  live: 'live',
  paused: 'paused',
  suspended: 'suspended',
  rejected: 'not accepted',
};

const FIELD_LABEL: Record<string, string> = {
  legal_name: 'legal name',
  country: 'country',
  website: 'website',
  vat_id: 'VAT ID',
};

export interface CommerceOrgFacts {
  name: string;
  role: string;
  partnerType: string | null;
  state: string;
  nextStep: string | null;
  openRequired: string[];
  companyMissing: string[];
}

interface Membership {
  role: string;
  partner_organization_id: string;
}

type Supa = any; // supabase client; typed loosely to keep this module light

export interface CommerceKnowledgeDeps {
  supabase: Supa | null;
  loadOrg: (s: Supa, id: string) => Promise<{ org: any | null; error: string | null }>;
  loadChecklist: (s: Supa, org: any) => Promise<{ checklist: any | null; error: string | null }>;
}

async function defaultDeps(): Promise<CommerceKnowledgeDeps> {
  const [{ getSupabase }, onboarding] = await Promise.all([
    import('../../lib/supabase'),
    import('../../routes/partner-onboarding'),
  ]);
  return { supabase: getSupabase(), loadOrg: onboarding.loadOrg, loadChecklist: onboarding.loadChecklist };
}

export async function loadCommerceOrgFacts(userId: string, deps?: CommerceKnowledgeDeps): Promise<CommerceOrgFacts[]> {
  const d = deps ?? (await defaultDeps());
  if (!d.supabase || !userId) return [];
  const { data, error } = await d.supabase
    .from('partner_organization_members')
    .select('role, partner_organization_id')
    .eq('user_id', userId)
    .limit(MAX_ORGS);
  if (error || !Array.isArray(data)) return [];
  const out: CommerceOrgFacts[] = [];
  for (const m of data as Membership[]) {
    const { org } = await d.loadOrg(d.supabase, m.partner_organization_id);
    if (!org) continue;
    const { checklist } = await d.loadChecklist(d.supabase, org);
    const steps: Array<{ key: string; required: boolean; status: string; missing?: string[] }> = checklist?.steps ?? [];
    out.push({
      name: String(org.display_name ?? ''),
      role: m.role,
      partnerType: org.partner_type ?? null,
      state: String(org.lifecycle_state ?? 'draft'),
      nextStep: checklist?.next_step ?? null,
      openRequired: steps.filter((s) => s.required && s.status !== 'done' && s.status !== 'not_required').map((s) => s.key),
      companyMissing: steps.find((s) => s.key === 'company')?.missing ?? [],
    });
  }
  return out;
}

const label = (map: Record<string, string>, key: string) => map[key] ?? key.replace(/_/g, ' ');

/** The facts as prompt text (English) and as short opener highlights. */
export function renderCommerceFacts(orgs: CommerceOrgFacts[]): { text: string; highlights: string[] } {
  if (orgs.length === 0) {
    return {
      text: 'YOUR SUPPLIER (loaded as this session opened): no business on Vitanaland yet — setting one up is the first step.',
      highlights: ['The user has no business on Vitanaland yet.'],
    };
  }
  const lines: string[] = [];
  const highlights: string[] = [];
  for (const o of orgs) {
    const parts = [
      `- ${o.name} (${o.partnerType ? label({}, o.partnerType) : 'type not chosen'}; the user is ${label({}, o.role)}): ${label(STATE_LABEL, o.state)}.`,
    ];
    if (o.state !== 'live' && o.openRequired.length > 0) {
      parts.push(`Still open: ${o.openRequired.map((k) => label(STEP_LABEL, k)).join(', ')}.`);
    }
    if (o.companyMissing.length > 0) parts.push(`Company details missing: ${o.companyMissing.map((f) => label(FIELD_LABEL, f)).join(', ')}.`);
    if (o.nextStep) parts.push(`Next step: ${label(STEP_LABEL, o.nextStep)}.`);
    lines.push(parts.join(' '));
    highlights.push(
      `${o.name}: ${label(STATE_LABEL, o.state)}${o.nextStep && o.state !== 'live' ? `; next step ${label(STEP_LABEL, o.nextStep)}` : ''}.`,
    );
  }
  return {
    text: `YOUR SUPPLIER'S BUSINESSES (loaded as this session opened — current enough to guide from):\n${lines.join('\n')}`,
    highlights,
  };
}

export async function loadCommerceKnowledge(userId: string, deps?: CommerceKnowledgeDeps): Promise<WorkSurfaceKnowledge> {
  const orgs = await loadCommerceOrgFacts(userId, deps);
  const { text, highlights } = renderCommerceFacts(orgs);
  return { systemSnapshot: text, domainAtlas: null, devMemory: null, pulse: { highlights, asOf: new Date().toISOString() } };
}
