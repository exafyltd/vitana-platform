/**
 * VTID-04510 (Community Autopilot CA-8): automations propose, they do not act.
 *
 * Some community automations used to act on members' behalf without asking:
 * AP-0201/AP-0209 created groups and put members in them, AP-0410 connected a
 * new member to whoever invited them and signed them up for the shared event,
 * AP-1306 posted a milestone to the member's social accounts. None of that is
 * something a member agreed to.
 *
 * Those handlers now call proposeToMember(): the same thing becomes a typed
 * Autopilot suggestion in the member's own queue, and happens only when the
 * member activates it (app button or a spoken yes, per CA-3's policy).
 *
 * The write goes through ctx.supabase, so shadow mode (VTID-04349) records it
 * and skips it like any other automation write. Nothing here notifies anyone.
 *
 * Guards, all enforced before the insert:
 *   - test/service accounts are never given a suggestion (rules 43-45);
 *   - a member with MAX_OPEN_PER_ROLE open suggestions gets no new one
 *     (owner decision 3, same cap as the scan ranker);
 *   - the same fingerprint is never proposed twice within 14 days, whatever
 *     happened to the first one.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_OPEN_PER_ROLE } from './ranker';
import { parseAction, type RecommendationAction } from './action-registry';

export const AUTOMATION_SOURCE_PREFIX = 'auto_';
export const AUTOMATION_PROPOSAL_TTL_HOURS = 72;
export const AUTOMATION_PROPOSAL_DEDUPE_DAYS = 14;

export type AutomationProposalTemplate =
  | 'group_interest'
  | 'group_interest_join'
  | 'group_circle'
  | 'connect_referrer'
  | 'event_rsvp_referral'
  | 'share_milestone';

export interface AutomationProposal {
  userId: string;
  template: AutomationProposalTemplate;
  params?: Record<string, string>;
  domain: string;
  action: RecommendationAction;
  /** Stable identity of the thing proposed, e.g. `group_interest:yoga`. */
  fingerprint: string;
  impact?: number;
}

export interface ProposalRunContext {
  supabase: SupabaseClient;
  automationId: string;
  runId: string;
}

export type ProposalOutcome =
  | 'proposed'
  | 'excluded_account'
  | 'queue_full'
  | 'duplicate'
  | 'invalid_action'
  | 'store_failed';

export interface ProposalDeps {
  now?: () => Date;
  excluded?: Set<string>;
  locale?: (sb: SupabaseClient, userId: string) => Promise<string>;
  translate?: (key: string, locale: string, params?: Record<string, string>) => string;
}

const OPEN = new Set(['new', 'snoozed']);

/** Pure: may this proposal be written, given the member's recent rows? */
export function checkProposal(a: {
  proposal: AutomationProposal;
  excluded: Set<string>;
  recent: Array<{ status: string; fingerprint: string | null; expires_at: string | null; created_at: string | null }>;
  now: Date;
}): Exclude<ProposalOutcome, 'proposed' | 'store_failed'> | null {
  const { proposal, excluded, recent, now } = a;
  if (excluded.has(proposal.userId)) return 'excluded_account';
  const p = proposal.action.params ?? {};
  for (const k of ['recipient_user_id', 'target_user_id']) {
    if (typeof p[k] === 'string' && excluded.has(p[k] as string)) return 'excluded_account';
  }
  if (!parseAction(proposal.action)) return 'invalid_action';
  const since = now.getTime() - AUTOMATION_PROPOSAL_DEDUPE_DAYS * 86400_000;
  if (recent.some((r) => r.fingerprint === proposal.fingerprint && (!r.created_at || Date.parse(r.created_at) >= since))) {
    return 'duplicate';
  }
  const open = recent.filter((r) => OPEN.has(r.status) && !(r.expires_at && Date.parse(r.expires_at) < now.getTime()));
  if (open.length >= MAX_OPEN_PER_ROLE) return 'queue_full';
  return null;
}

/** The row for one proposal, title/summary already in the member's language. */
export function buildProposalRow(
  proposal: AutomationProposal,
  run: { automationId: string; runId: string },
  text: { title: string; summary: string },
  now: Date,
) {
  return {
    user_id: proposal.userId,
    title: text.title,
    summary: text.summary,
    domain: proposal.domain,
    risk_level: 'low',
    impact_score: Math.max(1, Math.min(10, Math.round(proposal.impact ?? 6))),
    effort_score: 2,
    status: 'new',
    source_type: 'community',
    source_ref: `${AUTOMATION_SOURCE_PREFIX}${proposal.template}`,
    fingerprint: proposal.fingerprint,
    expires_at: new Date(now.getTime() + AUTOMATION_PROPOSAL_TTL_HOURS * 3600_000).toISOString(),
    time_estimate_seconds: 120,
    action: proposal.action,
    provenance: { source: 'automation', automation_id: run.automationId, run_id: run.runId, template: proposal.template },
  };
}

async function defaultLocale(sb: SupabaseClient, userId: string): Promise<string> {
  const { getUserLocale } = await import('../../i18n/server-locale');
  return getUserLocale(sb as any, userId);
}

async function defaultTranslate(key: string, locale: string, params?: Record<string, string>): Promise<string> {
  const { tt } = await import('../../i18n/catalog');
  return (tt as any)(key, locale, params);
}

/** Put one proposal in the member's Autopilot queue. Never throws. */
export async function proposeToMember(
  run: ProposalRunContext,
  proposal: AutomationProposal,
  deps: ProposalDeps = {},
): Promise<ProposalOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  try {
    let excluded = deps.excluded;
    if (!excluded) {
      const { fetchExcludedTestServiceAccountIds } = await import('../../lib/excluded-test-service-accounts');
      excluded = await fetchExcludedTestServiceAccountIds(run.supabase);
    }
    const since = new Date(now.getTime() - AUTOMATION_PROPOSAL_DEDUPE_DAYS * 86400_000).toISOString();
    const { data } = await run.supabase
      .from('autopilot_recommendations')
      .select('status,fingerprint,expires_at,created_at')
      .eq('user_id', proposal.userId)
      .gte('created_at', since)
      .limit(200);
    const reason = checkProposal({ proposal, excluded, recent: (data as any[]) ?? [], now });
    if (reason) return reason;

    const locale = await (deps.locale ?? defaultLocale)(run.supabase, proposal.userId);
    const t = async (k: string) => (deps.translate ? deps.translate(k, locale, proposal.params) : defaultTranslate(k, locale, proposal.params));
    const title = await t(`autopilot.auto.${proposal.template}.title`);
    const summary = await t(`autopilot.auto.${proposal.template}.summary`);
    const row = buildProposalRow(proposal, run, { title, summary }, now);
    const { error } = await run.supabase.from('autopilot_recommendations').insert(row);
    if (error) {
      console.warn(`[automation-proposals] ${run.automationId} insert failed for ${proposal.userId.slice(0, 8)}: ${(error as any).message}`);
      return 'store_failed';
    }
    return 'proposed';
  } catch (err) {
    console.warn(`[automation-proposals] ${run.automationId} failed: ${(err as Error).message}`);
    return 'store_failed';
  }
}

/** Count outcomes across a run, for the run log and the supervisor. */
export function tallyOutcomes(outcomes: ProposalOutcome[]): Record<ProposalOutcome, number> {
  const t = { proposed: 0, excluded_account: 0, queue_full: 0, duplicate: 0, invalid_action: 0, store_failed: 0 };
  for (const o of outcomes) t[o]++;
  return t;
}

/**
 * Automations still found (CA-0 audit) acting on a member's behalf or on
 * their data without a suggestion. The supervisor lists them, with their
 * registry names, so the remaining conversions stay visible.
 */
export const REMAINING_SILENT_ACTORS: ReadonlyArray<string> = [
  'AP-0103', 'AP-0212', 'AP-0404', 'AP-0405', 'AP-0708', 'AP-1101', 'AP-1104', 'AP-1301', 'AP-1305',
];

/** Converted by CA-8: these now only propose. */
export const PROPOSING_AUTOMATIONS: ReadonlyArray<string> = ['AP-0201', 'AP-0209', 'AP-0410', 'AP-1306'];
