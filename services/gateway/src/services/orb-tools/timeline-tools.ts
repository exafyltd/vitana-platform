/**
 * VTID-05171 — Life Timeline P5: `get_my_timeline`, the companion's read of
 * the member's own Life Timeline.
 *
 * Same reader as GET /api/v1/timeline (services/timeline/*): only what the
 * member sees (spotlight + moment tiers), never rows the member hid from
 * Vitana, the Vitana Index day changes from the recorded movements
 * (VTID-05168), and each moment's influence — "measured" only when a movement
 * recorded it, otherwise what it counted toward. The tool returns structured
 * facts; the model composes the spoken answer (CLAUDE.md rule 41 — no
 * finished sentence here). Special-category moments carry their topic only,
 * never their values.
 *
 * Catalog placement: a community domain tool (NEW_DOMAIN_TOOL_DECLARATIONS);
 * on the byte-budgeted Vertex/Nova catalogs it is in LAST_RESORT_TOOLS
 * (vertex-tool-catalog-budget.ts) — packed only when everything else fits,
 * so it never displaces a priority tool. `get_vitana_index` and
 * `get_pillar_subscores` are unchanged.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { PILLAR_KEYS, type PillarKey } from '../../lib/vitana-pillars';
import { getTimelineCatalog } from '../timeline/catalog';
import * as repo from '../timeline/timeline-repository';
import { buildIndexDayCards, classifyRow, movementFor, toMoment, type TimelineMoment } from '../timeline/timeline-reader';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const RANGE_DAYS: Record<string, number> = { today: 1, week: 7, month: 30 };
const VISIBLE = ['spotlight', 'moment'];
const MAX_MOMENTS = 25;
const MAX_DAYS = 10;
const CATEGORIES = new Set(getTimelineCatalog().categories.filter((c) => c !== 'system'));

function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`;
}

function compactMoment(m: TimelineMoment) {
  const sensitive = m.sensitivity === 'special_category';
  return {
    at: m.at,
    topic: m.topic,
    category: m.category,
    pillar: m.pillar ?? m.secondary_pillar,
    details: sensitive ? {} : m.summary.params,
    influence: m.influence
      ? m.influence.kind === 'measured'
        ? { kind: 'measured', delta_total: m.influence.delta_total ?? 0, delta_pillars: m.influence.delta_pillars ?? {} }
        : { kind: 'counted', pillar: m.influence.pillar }
      : null,
  };
}

export async function tool_get_my_timeline(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'not_signed_in' };
  const range = typeof args.range === 'string' && RANGE_DAYS[args.range] ? args.range : 'week';
  const pillarArg = typeof args.pillar === 'string' ? args.pillar.toLowerCase() : '';
  const pillar = (PILLAR_KEYS as readonly string[]).includes(pillarArg) ? (pillarArg as PillarKey) : null;
  if (pillarArg && !pillar) return { ok: false, error: `pillar must be one of ${PILLAR_KEYS.join(', ')}` };
  const categoryArg = typeof args.category === 'string' ? args.category.toLowerCase() : '';
  const category = CATEGORIES.has(categoryArg) ? categoryArg : null;
  if (categoryArg && !category) return { ok: false, error: 'unknown category' };

  const now = new Date();
  const from = new Date(now.getTime() - RANGE_DAYS[range] * 86_400_000).toISOString();
  const to = now.toISOString();

  let rows: repo.ActivityRow[];
  const classified = await repo.fetchClassifiedRows(sb, { userId: id.user_id, tiers: VISIBLE, from, to, pillar, category, limit: 80 });
  if (classified.error) return { ok: false, error: 'timeline_unavailable' };
  if (classified.missingSchema) {
    const legacy = await repo.fetchLegacyRows(sb, { userId: id.user_id, from, to, limit: 300 });
    if (legacy.error) return { ok: false, error: 'timeline_unavailable' };
    rows = legacy.rows.filter((r) => {
      const c = classifyRow(r);
      if (!VISIBLE.includes(c.tier)) return false;
      if (pillar && c.pillar !== pillar && c.secondary_pillar !== pillar) return false;
      return !category || c.category === category;
    });
  } else {
    rows = classified.rows;
  }
  rows = rows.filter((r) => !r.hidden_from_ai).slice(0, MAX_MOMENTS);

  const movements = await repo.fetchMovementsBetween(sb, id.user_id, from, to);
  const byId = new Map(movements.map((m) => [m.id, m]));
  const moments = rows.map((r) => toMoment(r, movementFor(r, byId, movements)));
  const days = buildIndexDayCards(movements)
    .filter((d) => !pillar || (d.delta_pillars[pillar] ?? 0) !== 0)
    .slice(0, MAX_DAYS)
    .map((d) => ({ date: d.date, delta_total: d.delta_total, score_after: d.score_total_after, delta_pillars: d.delta_pillars, daily_update: d.daily_update }));

  const byPillar: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const m of moments) {
    const p = m.pillar ?? m.secondary_pillar;
    if (p) byPillar[p] = (byPillar[p] ?? 0) + 1;
    byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
  }

  // Data for the model, not a sentence to read out (rule 41).
  const facts: string[] = [`range=${range}`, `entries=${moments.length}`];
  if (days.length) {
    facts.push(
      `index_days=${days
        .map((d) => `${d.date}:${signed(d.delta_total)}[${Object.entries(d.delta_pillars).map(([p, v]) => `${p}${signed(Number(v))}`).join(' ')}]`)
        .join('; ')}`,
    );
  }
  if (moments.length) {
    facts.push(
      `latest=${moments
        .slice(0, 8)
        .map((m) => `${m.topic}${m.influence?.kind === 'measured' ? `(${signed(m.influence.delta_total ?? 0)})` : m.influence?.pillar ? `(counts:${m.influence.pillar})` : ''}`)
        .join(', ')}`,
    );
  }

  return {
    ok: true,
    result: {
      range,
      from,
      to,
      pillar,
      category,
      index_days: days,
      moments: moments.map(compactMoment),
      counts: { by_pillar: byPillar, by_category: byCategory },
    },
    text: facts.join(' | '),
  };
}

export const TIMELINE_TOOL_HANDLERS: Record<string, Handler> = {
  get_my_timeline: tool_get_my_timeline,
};

export const TIMELINE_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'get_my_timeline',
    description: [
      "Read the member's own Life Timeline: what they logged and did, how their Vitana Index",
      'changed each day and which pillar moved it (nutrition, hydration, exercise, sleep, mental).',
      'CALL WHEN the member asks what they did or how their week went: "what did I do this week?",',
      '"how did my sleep go lately?", "why did my Index go up yesterday?", "was habe ich diese Woche gemacht?".',
      'Answer in your own words from the returned facts; "measured" influence is a real Index change,',
      '"counted" means it counted toward that pillar without a measured change.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'today, week (default) or month.' },
        pillar: { type: 'string', description: 'Optional: nutrition, hydration, exercise, sleep or mental.' },
        category: { type: 'string', description: 'Optional life area, e.g. community, diary, journey, events.' },
      },
      required: [],
    },
  },
];
