/**
 * VTID-04650 (Community Autopilot, plan §3): templates nobody accepts retire.
 *
 * The ranker already suppresses a template for ONE member after they reject
 * it twice. This is the population view: across every member, how often was a
 * scan template shown and how often was it taken up? A template with enough
 * decided offers and (almost) no acceptance stops being proposed to anyone,
 * so the lineup is not filled with suggestions the community has already
 * said no to.
 *
 *   shown    = rows a member decided on: rejected, snoozed, activated, completed
 *   accepted = activated + completed
 *
 * Open rows (new) and system retirements (auto_archived — the lineup cap and
 * expiry, which the member may never have seen) count for neither side.
 *
 * Pure except loadTemplateStats (one read per scan run). A failed read retires
 * nothing (fail-open: the per-member rules still apply).
 * COMMUNITY_AUTOPILOT_TEMPLATE_RETIREMENT='false' switches retirement off.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const STATS_WINDOW_DAYS = 60;
/** Below this many decided offers a template has not had a fair test. */
export const RETIRE_MIN_SHOWN = 25;
/** At or above RETIRE_MIN_SHOWN, an acceptance rate below this retires it. */
export const RETIRE_MAX_ACCEPT_RATE = 0.03;

const SHOWN = new Set(['rejected', 'snoozed', 'activated', 'completed']);
const ACCEPTED = new Set(['activated', 'completed']);

export interface TemplateStat {
  template: string;
  shown: number;
  accepted: number;
  rejected: number;
  acceptRate: number;
}

export function computeTemplateStats(rows: Array<{ source_ref: string | null; status: string }>, prefix = 'scan_'): Map<string, TemplateStat> {
  const out = new Map<string, TemplateStat>();
  for (const r of rows) {
    if (typeof r.source_ref !== 'string' || !r.source_ref.startsWith(prefix)) continue;
    if (!SHOWN.has(r.status)) continue;
    const template = r.source_ref.slice(prefix.length);
    const s = out.get(template) ?? { template, shown: 0, accepted: 0, rejected: 0, acceptRate: 0 };
    s.shown += 1;
    if (ACCEPTED.has(r.status)) s.accepted += 1;
    if (r.status === 'rejected') s.rejected += 1;
    out.set(template, s);
  }
  for (const s of out.values()) s.acceptRate = s.shown ? s.accepted / s.shown : 0;
  return out;
}

export function selectRetiredTemplates(stats: Map<string, TemplateStat>): Set<string> {
  const retired = new Set<string>();
  for (const s of stats.values()) {
    if (s.shown >= RETIRE_MIN_SHOWN && s.acceptRate < RETIRE_MAX_ACCEPT_RATE) retired.add(s.template);
  }
  return retired;
}

export function isTemplateRetirementEnabled(): boolean {
  return process.env.COMMUNITY_AUTOPILOT_TEMPLATE_RETIREMENT !== 'false';
}

export async function loadRetiredTemplates(
  sb: SupabaseClient,
  now: Date,
): Promise<{ retired: Set<string>; stats: TemplateStat[] }> {
  if (!isTemplateRetirementEnabled()) return { retired: new Set(), stats: [] };
  try {
    const since = new Date(now.getTime() - STATS_WINDOW_DAYS * 86400_000).toISOString();
    const { data, error } = await sb
      .from('autopilot_recommendations')
      .select('source_ref,status')
      .eq('source_type', 'community')
      .like('source_ref', 'scan\\_%')
      .in('status', [...SHOWN])
      .gte('updated_at', since)
      .limit(50000);
    if (error) throw new Error((error as any).message);
    const stats = computeTemplateStats((data ?? []) as any[]);
    return { retired: selectRetiredTemplates(stats), stats: [...stats.values()] };
  } catch (err) {
    console.warn(`[community-scan] template stats unavailable, retiring nothing: ${(err as Error).message}`);
    return { retired: new Set(), stats: [] };
  }
}
