/**
 * VTID-05169 — Life Timeline P3: what the member sees, built from the
 * catalog (VTID-05167) and the recorded Index movements (VTID-05168).
 *
 * Principles (plan §1, docs/validation/VTID-05167/plan-sparring.md):
 *   - The Vitana Index is the headline: `buildSpotlight` returns the score,
 *     tier key, the five pillars with today's change and 7-day momentum, the
 *     balance factor with a plain-language reason KEY, the weakest pillar and
 *     today's top contributors (from movements only).
 *   - Influence is never invented: an item shows `measured` deltas only when
 *     a movement recorded them; otherwise `counted` (what pillar it counted
 *     toward) or nothing.
 *   - Moments, not logs: only spotlight/moment rows are listed; digest rows
 *     only inside a day digest (≥3 non-sensitive items); silent and system
 *     rows never. Text is `{ key, params }` — the app renders it.
 */
import { classifyActivityType, getTimelineCatalog, type TimelineTier } from './catalog';
import { PILLAR_KEYS, tierForScore, type PillarKey } from '../../lib/vitana-pillars';
import type { ActivityRow, MovementRow, ScoreRow } from './timeline-repository';

export interface Influence {
  kind: 'measured' | 'counted';
  delta_total?: number;
  delta_pillars?: Partial<Record<PillarKey, number>>;
  pillar?: PillarKey;
  movement_id?: string;
}

export interface TimelineMoment {
  kind: 'moment';
  id: string;
  at: string;
  tier: TimelineTier;
  activity_type: string;
  pillar: PillarKey | null;
  secondary_pillar: PillarKey | null;
  category: string;
  topic: string;
  icon: string;
  sensitivity: 'standard' | 'special_category';
  summary: { key: string; params: Record<string, string | number | boolean> };
  influence: Influence | null;
  hidden_from_ai: boolean;
}

export interface IndexDayCard {
  kind: 'index_day';
  id: string;
  date: string;
  delta_total: number;
  score_total_after: number | null;
  delta_pillars: Partial<Record<PillarKey, number>>;
  top_pillar: PillarKey | null;
  movements: number;
  daily_update: boolean;
}

export interface DayDigest {
  kind: 'day_digest';
  id: string;
  date: string;
  counts: Record<string, number>;
  total: number;
}

export type TimelineItem = TimelineMoment | IndexDayCard | DayDigest;

const MAX_PARAM_LEN = 120;
const DIGEST_MIN_ITEMS = 3;
const MOMENTUM_BAND = 5;

const ENTRY_PARAMS = new Map<string, string[]>(getTimelineCatalog().entries.map((e) => [e.type, e.params]));

function isPillar(v: unknown): v is PillarKey {
  return typeof v === 'string' && (PILLAR_KEYS as readonly string[]).includes(v);
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Classification: the row's own columns when present (after VTID-05167), else the catalog. */
export function classifyRow(row: ActivityRow) {
  const c = classifyActivityType(row.activity_type);
  return {
    tier: ((row.tier as TimelineTier | null) ?? c.tier) as TimelineTier,
    category: row.category ?? c.category,
    topic: row.topic ?? c.topic,
    pillar: (isPillar(row.pillar) ? row.pillar : c.pillar) as PillarKey | null,
    secondary_pillar: (isPillar(row.secondary_pillar) ? row.secondary_pillar : c.secondary_pillar) as PillarKey | null,
    icon: c.icon,
    sensitivity: c.sensitivity,
    summary_key: c.summary_key,
    params: c.matched ? ENTRY_PARAMS.get(c.matched) ?? c.params : c.params,
  };
}

function pickParams(data: Record<string, unknown> | null, allowed: string[]) {
  const out: Record<string, string | number | boolean> = {};
  if (!data) return out;
  for (const k of allowed) {
    const v = data[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, MAX_PARAM_LEN);
  }
  return out;
}

function nonZero(d: Record<string, number> | null | undefined): Partial<Record<PillarKey, number>> {
  const out: Partial<Record<PillarKey, number>> = {};
  for (const p of PILLAR_KEYS) {
    const v = Number(d?.[p] ?? 0);
    if (v) out[p] = v;
  }
  return out;
}

function topPillar(d: Partial<Record<PillarKey, number>>): PillarKey | null {
  let best: PillarKey | null = null;
  for (const p of PILLAR_KEYS) {
    const v = d[p] ?? 0;
    if (v > 0 && (best === null || v > (d[best] ?? 0))) best = p;
  }
  return best;
}

/** The movement that measured this row: its own movement_id, else (wearable sync) the nearest wearable_sync movement within 5 min. */
export function movementFor(row: ActivityRow, byId: Map<string, MovementRow>, all: MovementRow[]): MovementRow | null {
  const id = typeof row.activity_data?.movement_id === 'string' ? (row.activity_data.movement_id as string) : null;
  if (id && byId.has(id)) return byId.get(id)!;
  if (row.activity_type === 'health.wearable_features.bridged') {
    const t = Date.parse(row.created_at);
    let best: MovementRow | null = null;
    for (const m of all) {
      if (m.trigger !== 'wearable_sync') continue;
      const d = Math.abs(Date.parse(m.at) - t);
      if (d <= 5 * 60_000 && (!best || d < Math.abs(Date.parse(best.at) - t))) best = m;
    }
    return best;
  }
  return null;
}

export function toMoment(row: ActivityRow, movement: MovementRow | null): TimelineMoment {
  const c = classifyRow(row);
  let influence: Influence | null = null;
  if (movement) {
    influence = {
      kind: 'measured',
      delta_total: Number(movement.delta_total ?? 0),
      delta_pillars: nonZero(movement.delta_pillars),
      movement_id: movement.id,
    };
  } else if (c.pillar || c.secondary_pillar) {
    influence = { kind: 'counted', pillar: (c.pillar ?? c.secondary_pillar) as PillarKey };
  }
  return {
    kind: 'moment',
    id: row.id,
    at: row.created_at,
    tier: c.tier,
    activity_type: row.activity_type,
    pillar: c.pillar,
    secondary_pillar: c.secondary_pillar,
    category: c.category,
    topic: c.topic,
    icon: c.icon,
    sensitivity: c.sensitivity,
    summary: { key: c.summary_key, params: pickParams(row.activity_data, c.params) },
    influence,
    hidden_from_ai: !!row.hidden_from_ai,
  };
}

/** One card per day the Index changed: the day's summed movements. */
export function buildIndexDayCards(movements: MovementRow[]): IndexDayCard[] {
  const byDay = new Map<string, MovementRow[]>();
  for (const m of movements) {
    const d = m.score_date || dayOf(m.at);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(m);
  }
  const cards: IndexDayCard[] = [];
  for (const [date, ms] of byDay) {
    const sorted = [...ms].sort((a, b) => a.at.localeCompare(b.at));
    const sum: Record<string, number> = {};
    let total = 0;
    for (const m of sorted) {
      total += Number(m.delta_total ?? 0);
      for (const p of PILLAR_KEYS) sum[p] = (sum[p] ?? 0) + Number(m.delta_pillars?.[p] ?? 0);
    }
    const dp = nonZero(sum);
    const last = sorted[sorted.length - 1];
    if (total === 0 && Object.keys(dp).length === 0) continue;
    cards.push({
      kind: 'index_day',
      id: `index-day:${date}`,
      date,
      delta_total: total,
      score_total_after: typeof last.after?.score_total === 'number' ? (last.after.score_total as number) : null,
      delta_pillars: dp,
      top_pillar: topPillar(dp),
      movements: sorted.length,
      daily_update: sorted.some((m) => m.trigger === 'daily'),
    });
  }
  return cards.sort((a, b) => b.date.localeCompare(a.date));
}

/** "Your day" digest: ≥3 non-sensitive digest-tier rows on a day; special-category rows never count. */
export function buildDayDigests(rows: ActivityRow[]): DayDigest[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const c = classifyRow(r);
    if (c.tier !== 'digest' || c.sensitivity === 'special_category') continue;
    const d = dayOf(r.created_at);
    const counts = byDay.get(d) ?? {};
    counts[c.topic] = (counts[c.topic] ?? 0) + 1;
    byDay.set(d, counts);
  }
  const out: DayDigest[] = [];
  for (const [date, counts] of byDay) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total >= DIGEST_MIN_ITEMS) out.push({ kind: 'day_digest', id: `day-digest:${date}`, date, counts, total });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Merge moments, Index day cards and digests: newest day first; within a day Index card, digest, then moments. */
export function mergeItems(moments: TimelineMoment[], dayCards: IndexDayCard[], digests: DayDigest[]): TimelineItem[] {
  const days = new Set<string>([...moments.map((m) => dayOf(m.at)), ...dayCards.map((c) => c.date), ...digests.map((d) => d.date)]);
  const out: TimelineItem[] = [];
  for (const day of [...days].sort().reverse()) {
    out.push(...dayCards.filter((c) => c.date === day));
    out.push(...digests.filter((d) => d.date === day));
    out.push(...moments.filter((m) => dayOf(m.at) === day));
  }
  return out;
}

export interface Spotlight {
  score_total: number;
  tier: string;
  change_today: number;
  change_7d: number | null;
  pillars: Record<PillarKey, { score: number; change_today: number; momentum: 'rising' | 'steady' | 'slipping' | 'unknown' }>;
  balance: { factor: number | null; penalty_pct: number; reason_key: string; weakest_pillar: PillarKey | null };
  weakest_pillar: PillarKey | null;
  strongest_pillar: PillarKey | null;
  top_contributors: Array<{ trigger: string; source_kind: string | null; delta_total: number; top_pillar: PillarKey | null; at: string }>;
  last_computed: string | null;
}

export function tierKey(total: number): string {
  return tierForScore(total).name.toLowerCase().replace(/[^a-z]+/g, '_');
}

/**
 * The Vitana Index headline. `scores` is ascending by date (last 8 days);
 * `todayMovements` are today's movements. Returns null when the member has no score yet.
 */
export function buildSpotlight(scores: ScoreRow[], todayMovements: MovementRow[], balanceFactor: number | null): Spotlight | null {
  if (scores.length === 0) return null;
  const latest = scores[scores.length - 1];
  const first = scores[0];
  const today: Record<string, number> = {};
  let changeToday = 0;
  for (const m of todayMovements) {
    changeToday += Number(m.delta_total ?? 0);
    for (const p of PILLAR_KEYS) today[p] = (today[p] ?? 0) + Number(m.delta_pillars?.[p] ?? 0);
  }
  const score = (r: ScoreRow, p: PillarKey) => Number((r as unknown as Record<string, number>)[`score_${p}`] ?? 0);
  const pillars = {} as Spotlight['pillars'];
  let weakest: PillarKey | null = null;
  let strongest: PillarKey | null = null;
  for (const p of PILLAR_KEYS) {
    const now = score(latest, p);
    const diff = scores.length > 1 ? now - score(first, p) : null;
    pillars[p] = {
      score: now,
      change_today: today[p] ?? 0,
      momentum: diff === null ? 'unknown' : diff >= MOMENTUM_BAND ? 'rising' : diff <= -MOMENTUM_BAND ? 'slipping' : 'steady',
    };
    if (weakest === null || now < pillars[weakest].score) weakest = p;
    if (strongest === null || now > pillars[strongest].score) strongest = p;
  }
  const factor = balanceFactor === null || !Number.isFinite(balanceFactor) ? null : balanceFactor;
  const penalty = factor === null ? 0 : Math.max(0, Math.round((1 - factor) * 100));
  const contributors = [...todayMovements]
    .filter((m) => m.trigger !== 'daily' && Number(m.delta_total ?? 0) !== 0)
    .sort((a, b) => Math.abs(Number(b.delta_total)) - Math.abs(Number(a.delta_total)))
    .slice(0, 3)
    .map((m) => ({
      trigger: m.trigger,
      source_kind: m.source_kind,
      delta_total: Number(m.delta_total),
      top_pillar: topPillar(nonZero(m.delta_pillars)),
      at: m.at,
    }));
  return {
    score_total: Number(latest.score_total ?? 0),
    tier: tierKey(Number(latest.score_total ?? 0)),
    change_today: changeToday,
    change_7d: scores.length > 1 ? Number(latest.score_total) - Number(first.score_total) : null,
    pillars,
    balance: {
      factor,
      penalty_pct: penalty,
      reason_key: penalty > 0 ? 'timeline.balance.held_back' : 'timeline.balance.full',
      weakest_pillar: penalty > 0 ? weakest : null,
    },
    weakest_pillar: weakest,
    strongest_pillar: strongest,
    top_contributors: contributors,
    last_computed: latest.date ?? null,
  };
}
