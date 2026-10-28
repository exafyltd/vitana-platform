/**
 * VTID-04883: community ranking decisions D1–D3, D5–D8 in shadow (docs/JEV-INTEGRATION-PLAN.md §10.4 D).
 *
 *   community_calendar_priority  D1  after the calendar prioritizer scored a member's events
 *   community_next_action        D2  after the next-action composer ranked its slate
 *   community_match_rerank       D3  after search_intent_catalog_v2 ranked Find-a-Match candidates
 *   community_suggestion_pick    D5  after the pillar-weighted ranking of a member's Autopilot suggestions
 *   community_notification_worth D6  after a notification was written and pushed (sampled)
 *   community_feed_pick          D7  after the Discover product feed was ranked (sampled)
 *   community_member_tiebreak    D8  on the member-search query-hash fallback only
 *
 * Mode: JEV_COMMUNITY_<GATE>_MODE (e.g. JEV_COMMUNITY_CALENDAR_PRIORITY_MODE). Sampled gates also read
 * JEV_COMMUNITY_<GATE>_SAMPLE (0..1; default 0.1), decided by a hash of the subject, so a fan-out is
 * sampled evenly and no member is always or never sampled.
 *
 * Every gate is fire-and-forget, after the existing logic has decided: nothing here changes a result,
 * awaits on a member's path, or throws. One Jev call per request, never per candidate. A gate runs only
 * when its mode is shadow (enforce has no path and behaves as shadow), the member plane is open
 * (JEV_COMMUNITY_ENABLED), a tenant is known and the member is known (the Class B per-member quota needs
 * the member). Inside decide() the member rules still apply: tenant flag, budget, member spend, rate share.
 *
 * Agreement: Jev's pick equals the existing top-1 (candidates are listed in the existing order, so the
 * existing pick is c1 unless stated). A pick beyond the listed candidates is recorded with agreed = null.
 * A shadow row holds no member text: a hashed subject and the slots.
 */

import { createHash } from 'crypto';
import { RANKING_SLOTS } from '../jev-decisions';
import { decide } from '../jev-decision-service';
import { isJevCommunityEnabled } from '../jev-access';
import { jevGateMode, jevGateEnvName, recordJevShadowDecision } from '../jev-shadow';
import type { CommunityGateDeps } from './community-class-a-gates';

export const RANKING_GATES = {
  calendar: 'community_calendar_priority',
  nextAction: 'community_next_action',
  matchRerank: 'community_match_rerank',
  suggestion: 'community_suggestion_pick',
  notification: 'community_notification_worth',
  feed: 'community_feed_pick',
  memberTiebreak: 'community_member_tiebreak',
} as const;
export const COMMUNITY_RANKING_GATES = Object.values(RANKING_GATES);

const ACTOR = 'community-ranking';
export const MAX_RANKING_CANDIDATES = RANKING_SLOTS.length;
export const DEFAULT_SAMPLE_RATE = 0.1;

type Field = string | number | boolean | null;
export type RankingFields = Record<string, Field>;

const hash = (...parts: Array<string | null | undefined>) =>
  createHash('sha256').update(parts.map((p) => p ?? '').join('|')).digest('hex');

/** A stable, non-reversible subject reference: never a member id or text. */
export function rankingSubjectRef(...parts: Array<string | null | undefined>): string {
  return hash(...parts).slice(0, 32);
}

/** Sample rate for a gate from JEV_COMMUNITY_<GATE>_SAMPLE (0..1); invalid or unset → default. */
export function rankingSampleRate(gate: string, env: NodeJS.ProcessEnv = process.env, fallback = DEFAULT_SAMPLE_RATE): number {
  const raw = env[jevGateEnvName(gate).replace(/_MODE$/, '_SAMPLE')];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Deterministic: the same subject always gets the same answer for a given rate. */
export function isSampled(subject: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return parseInt(hash('sample', subject).slice(0, 8), 16) / 0x100000000 < rate;
}

/** Text that may hold names or values is never sent: cut to a short length band. */
export const lengthBand = (s: string | null | undefined): string => {
  const n = (s ?? '').length;
  return n === 0 ? 'none' : n <= 30 ? 'short' : n <= 100 ? 'medium' : 'long';
};

/** Hours until a time, in coarse bands. */
export function hoursBand(iso: string | null | undefined, now: Date = new Date()): string {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return 'unknown';
  const h = (t - now.getTime()) / 3_600_000;
  if (h < 0) return 'past';
  if (h <= 24) return 'within_24h';
  if (h <= 72) return 'within_3d';
  return 'later';
}

export interface RankingShadowCall {
  gate: string;
  tenantId: string | null | undefined;
  memberId: string | null | undefined;
  subjectType: string;
  subjectRef: string;
  context: RankingFields;
  /** In the existing order; cut to 8 here. */
  candidates: RankingFields[];
  /** Index (0-based) of the existing pick within `candidates`; default 0 (the existing top-1). */
  existingIndex?: number;
  /** When set, only this share of subjects runs (deterministic by subjectRef). */
  sampleRate?: number;
}

/**
 * The one shadow runner. Returns the shadow row id, or null when the gate did not run or failed.
 * Never throws.
 */
export async function runRankingShadow(c: RankingShadowCall, d: CommunityGateDeps = {}): Promise<string | null> {
  const env = d.env ?? process.env;
  try {
    const mode = jevGateMode(c.gate, env);
    if (mode === 'off' || !isJevCommunityEnabled(env) || !c.tenantId || !c.memberId) return null;
    if (c.candidates.length === 0) return null;
    if (c.sampleRate !== undefined && !isSampled(c.subjectRef, c.sampleRate)) return null;

    const truncated = c.candidates.length > MAX_RANKING_CANDIDATES;
    const candidates = c.candidates.slice(0, MAX_RANKING_CANDIDATES);
    const existingIndex = c.existingIndex ?? 0;
    const existing = existingIndex >= 0 && existingIndex < candidates.length ? RANKING_SLOTS[existingIndex] : null;

    const r = await decide(
      c.gate,
      { context: { ...c.context, candidate_count: c.candidates.length, truncated }, candidates },
      { actor_id: ACTOR, system: true, system_plane: 'system_autopilot', tenant_id: c.tenantId },
      { ...(d.decideOptions || {}), source: `gate:${c.gate}`, env, member_id: c.memberId },
    );
    const value = r.ok && r.outcome === 'decided' ? String(r.verdict.value) : null;
    const pickIndex = value ? (RANKING_SLOTS as readonly string[]).indexOf(value) : -1;
    const validPick = pickIndex >= 0 && pickIndex < candidates.length;
    const agreed = value === null || existing === null || !validPick ? null : value === existing;
    return await (d.record ?? recordJevShadowDecision)({
      gate: c.gate,
      decision: c.gate,
      mode,
      plane: 'member',
      tenant_id: c.tenantId,
      subject_type: c.subjectType,
      subject_ref: c.subjectRef,
      jev_outcome: r.outcome,
      jev_verdict: r.ok
        ? { value, valid_pick: validPick, existing, candidate_count: c.candidates.length, truncated }
        : { reason: r.reason, existing },
      jev_confidence: r.ok ? r.verdict.confidence : null,
      system_action: existing ? `existing_${existing}` : 'existing_none',
      cost_usd: r.ok ? r.cost_usd : 0,
      agreed,
      outcome: agreed === null ? null : 'compared_with_existing',
      outcome_at: agreed === null ? null : new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[jev] ${c.gate} shadow failed: ${err?.message || err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Per-gate builders: each maps the existing logic's own data to the minimal state. Callers fire them with
// `void shadowX(...).catch(() => undefined)` after the existing result is final.
// ---------------------------------------------------------------------------------------------------------

/** D1: the member's upcoming events, ordered by the prioritizer's new score (highest first). */
export function shadowCalendarPriority(
  a: {
    tenantId: string | null | undefined;
    userId: string;
    weakestPillar: string | null;
    events: Array<{ id: string; score: number; event_type?: string | null; pillar?: string | null; start_time?: string | null; reschedule_count?: number | null; source_type?: string | null }>;
    now?: Date;
  },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  const ordered = [...a.events].sort((x, y) => y.score - x.score);
  return runRankingShadow(
    {
      gate: RANKING_GATES.calendar,
      tenantId: a.tenantId,
      memberId: a.userId,
      subjectType: 'community_calendar_run',
      subjectRef: rankingSubjectRef('calendar', a.userId, ordered.map((e) => `${e.id}:${e.score}`).join(',')),
      context: { weakest_pillar: a.weakestPillar },
      candidates: ordered.map((e) => ({
        event_type: e.event_type ?? null,
        pillar: e.pillar ?? null,
        starts: hoursBand(e.start_time, a.now),
        reschedule_count: e.reschedule_count ?? 0,
        source_type: e.source_type ?? null,
        existing_score: e.score,
      })),
    },
    d,
  );
}

/** D2: the next-action slate (sources with a candidate), ordered as rank() orders it. */
export function shadowNextAction(
  a: {
    tenantId: string | null | undefined;
    userId: string;
    surface: string;
    chosenSource: string | null;
    slate: Array<{ source: string; priority: number; confidence: string; reasonCount: number }>;
  },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  const ordered = [...a.slate].sort((x, y) => y.priority - x.priority);
  const chosen = a.chosenSource ? ordered.findIndex((s) => s.source === a.chosenSource) : -1;
  return runRankingShadow(
    {
      gate: RANKING_GATES.nextAction,
      tenantId: a.tenantId,
      memberId: a.userId,
      subjectType: 'community_next_action_compose',
      subjectRef: rankingSubjectRef('next_action', a.userId, a.surface, new Date().toISOString().slice(0, 16)),
      context: { surface: a.surface, existing_chose_nothing: chosen < 0 },
      candidates: ordered.map((s) => ({ source: s.source, priority: s.priority, confidence: s.confidence, reasons: s.reasonCount })),
      existingIndex: chosen,
    },
    d,
  );
}

/** D3: Find-a-Match candidates from the SQL ranking (SQL #1 first). Not called on the exact-name path. */
export function shadowMatchRerank(
  a: {
    tenantId: string | null | undefined;
    userId: string;
    intentKind: string;
    category: string | null;
    candidates: Array<{ cand_kind: string; cand_title: string | null; score: number; reasons: Record<string, unknown> }>;
  },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  return runRankingShadow(
    {
      gate: RANKING_GATES.matchRerank,
      tenantId: a.tenantId,
      memberId: a.userId,
      subjectType: 'community_find_match',
      subjectRef: rankingSubjectRef('match', a.userId, a.intentKind, a.category, String(a.candidates.length), new Date().toISOString().slice(0, 16)),
      context: { intent_kind: a.intentKind, category: a.category },
      candidates: a.candidates.map((c) => ({
        kind: c.cand_kind,
        title_length: lengthBand(c.cand_title),
        sql_score: num(c.score),
        location_fit: num(c.reasons?.location_fit),
        time_fit: num(c.reasons?.time_fit),
        activity_fit: num(c.reasons?.activity_fit),
        profile_fit: num(c.reasons?.profile_fit),
        activity_exact: typeof c.reasons?.activity_exact === 'boolean' ? (c.reasons.activity_exact as boolean) : null,
      })),
    },
    d,
  );
}

/** D5: a member's Autopilot suggestions in the ranked order. */
export function shadowSuggestionPick(
  a: {
    tenantId: string | null | undefined;
    userId: string;
    runId: string | null;
    suggestions: Array<{ domain: string; source_type: string; impact_score: number; effort_score: number; risk_level: string; time_estimate_seconds?: number | null }>;
  },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  return runRankingShadow(
    {
      gate: RANKING_GATES.suggestion,
      tenantId: a.tenantId,
      memberId: a.userId,
      subjectType: 'community_suggestion_batch',
      subjectRef: rankingSubjectRef('suggestion', a.userId, a.runId),
      context: {},
      candidates: a.suggestions.map((s) => ({
        domain: s.domain,
        source_type: s.source_type,
        impact: s.impact_score,
        effort: s.effort_score,
        risk: s.risk_level,
        minutes: s.time_estimate_seconds ? Math.round(s.time_estimate_seconds / 60) : null,
      })),
    },
    d,
  );
}

/** D6: was a notification just sent worth it (sampled by notification id). */
export async function shadowNotificationWorth(
  a: {
    tenantId: string | null | undefined;
    userId: string;
    notificationId: string | null;
    type: string;
    category: string;
    priority: string;
    channel: string;
    pushed: boolean;
    dnd: boolean;
  },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  const env = d.env ?? process.env;
  const gate = RANKING_GATES.notification;
  try {
    if (!a.notificationId || jevGateMode(gate, env) === 'off' || !isJevCommunityEnabled(env) || !a.tenantId) return null;
    const subjectRef = rankingSubjectRef('notification', a.notificationId);
    if (!isSampled(subjectRef, rankingSampleRate(gate, env))) return null;
    const r = await decide(
      gate,
      {
        notification: { type: a.type, category: a.category, priority: a.priority, channel: a.channel, pushed: a.pushed },
        context: { quiet_hours: a.dnd, hour_utc: new Date().getUTCHours() },
      },
      { actor_id: ACTOR, system: true, system_plane: 'system_autopilot', tenant_id: a.tenantId },
      { ...(d.decideOptions || {}), source: `gate:${gate}`, env, member_id: a.userId },
    );
    const value = r.ok && r.outcome === 'decided' ? String(r.verdict.value) : null;
    // The existing logic sent it, i.e. judged it worth sending.
    const agreed = value === null ? null : value === 'true';
    return await (d.record ?? recordJevShadowDecision)({
      gate,
      decision: gate,
      mode: jevGateMode(gate, env),
      plane: 'member',
      tenant_id: a.tenantId,
      subject_type: 'community_notification',
      subject_ref: subjectRef,
      jev_outcome: r.outcome,
      jev_verdict: r.ok ? { value, existing: 'sent' } : { reason: r.reason, existing: 'sent' },
      jev_confidence: r.ok ? r.verdict.confidence : null,
      system_action: 'existing_sent',
      cost_usd: r.ok ? r.cost_usd : 0,
      agreed,
      outcome: agreed === null ? null : 'compared_with_existing',
      outcome_at: agreed === null ? null : new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[jev] ${gate} shadow failed: ${err?.message || err}`);
    return null;
  }
}

/** D7: the Discover product feed's first items in the ranked order (sampled by request). */
export function shadowFeedPick(
  a: {
    tenantId: string | null | undefined;
    userId: string | null;
    requestRef: string;
    lifecycleStage: string;
    regionGroup: string;
    items: Array<{ category?: string | null; price_cents?: number | null; rating?: number | null; origin_region?: string | null; health_goals?: string[] | null }>;
  },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  const env = d.env ?? process.env;
  const priceBand = (c: number | null | undefined) => (c == null ? null : c < 2000 ? 'low' : c < 8000 ? 'mid' : 'high');
  return runRankingShadow(
    {
      gate: RANKING_GATES.feed,
      tenantId: a.tenantId,
      memberId: a.userId,
      subjectType: 'community_feed_request',
      subjectRef: rankingSubjectRef('feed', a.requestRef),
      context: { lifecycle_stage: a.lifecycleStage, region_group: a.regionGroup },
      candidates: a.items.map((p) => ({
        category: p.category ?? null,
        price: priceBand(p.price_cents),
        rating: p.rating ?? null,
        origin_region: p.origin_region ?? null,
        goal_count: (p.health_goals ?? []).length,
      })),
      sampleRate: rankingSampleRate(RANKING_GATES.feed, env),
    },
    d,
  );
}

/**
 * D8: the member-search fallback. Candidates are the hash pick and the next pool members after it
 * (wrapping), so the existing pick is c1. No names: same-city/country flags and tenure only.
 */
export function shadowMemberTiebreak(
  a: {
    tenantId: string | null | undefined;
    viewerId: string;
    query: string;
    lane: string;
    viewerCity: string | null;
    viewerCountry: string | null;
    pool: Array<{ user_id: string; city: string | null; country: string | null; registration_seq: number | null }>;
    pickUserId: string;
  },
  d: CommunityGateDeps = {},
): Promise<string | null> {
  const start = Math.max(0, a.pool.findIndex((c) => c.user_id === a.pickUserId));
  const window: typeof a.pool = [];
  for (let i = 0; i < Math.min(a.pool.length, MAX_RANKING_CANDIDATES); i++) window.push(a.pool[(start + i) % a.pool.length]);
  const same = (x: string | null, y: string | null) => (x && y ? x.toLowerCase() === y.toLowerCase() : null);
  return runRankingShadow(
    {
      gate: RANKING_GATES.memberTiebreak,
      tenantId: a.tenantId,
      memberId: a.viewerId,
      subjectType: 'community_member_search',
      subjectRef: rankingSubjectRef('member_search', a.viewerId, a.query),
      context: { search: a.query.slice(0, 120), lane: a.lane, pool_size: a.pool.length },
      candidates: window.map((c) => ({
        same_city: same(c.city, a.viewerCity),
        same_country: same(c.country, a.viewerCountry),
        registration_seq: c.registration_seq,
      })),
    },
    d,
  );
}
