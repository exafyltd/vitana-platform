/**
 * VTID-05169 — Life Timeline P3: the member's timeline API.
 *
 *   GET    /api/v1/timeline/spotlight          the Vitana Index headline (score, tier, 5 pillars with
 *                                              today's change + 7-day momentum, balance, weakest pillar,
 *                                              today's top contributors)
 *   GET    /api/v1/timeline?cursor&pillar&category&from&to&q&limit
 *                                              Index day cards + "Your day" digests + moments, newest first
 *   GET    /api/v1/timeline/summary?from&to     counts per pillar / category / day (chips, date jump)
 *   GET    /api/v1/timeline/:id                 one moment, readable, with its Index influence
 *   POST   /api/v1/timeline/:id/hide-from-ai    { hidden: boolean }
 *   DELETE /api/v1/timeline/:id
 *   GET    /api/v1/timeline/learning-prefs      VTID-05171: per-category "Vitana may learn from this" (missing = on)
 *   PUT    /api/v1/timeline/learning-prefs      { category, learn } — app_usage off deletes the app-usage routines
 *   GET    /api/v1/timeline/usage-data          how many stored-but-silent rows (screen visits, technical traces)
 *   GET    /api/v1/timeline/usage-data/export   those rows as a JSON download
 *   DELETE /api/v1/timeline/usage-data          delete them all (+ the app-usage routines)
 *   GET    /api/v1/timeline/routines            the routines Vitana noticed (user_routines, confidence ≥ 0.5)
 *   DELETE /api/v1/timeline/routines/:id        forget one
 *
 * Auth: requireAuth; the user comes from the JWT only and every read/write is
 * filtered by it. Text is { key, params } — the app renders it in the
 * member's language (server i18n rule §13b: no user-visible strings here).
 * Plan: docs/validation/VTID-05167/plan-sparring.md §5 P3.
 */
import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { PILLAR_KEYS } from '../lib/vitana-pillars';
import { getTimelineCatalog } from '../services/timeline/catalog';
import * as repo from '../services/timeline/timeline-repository';
import {
  buildDayDigests,
  buildIndexDayCards,
  buildSpotlight,
  classifyRow,
  mergeItems,
  movementFor,
  toMoment,
} from '../services/timeline/timeline-reader';
import {
  APP_USAGE_ROUTINE_KINDS,
  LEARNABLE_CATEGORIES,
  fetchLearningPrefs,
  isLearnableCategory,
  setLearningPref,
} from '../services/timeline/learning-prefs';

const router = Router();
const VTID = 'VTID-05169';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const VISIBLE_TIERS = ['spotlight', 'moment'];
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const CATEGORIES = new Set(getTimelineCatalog().categories);

function userOf(req: AuthenticatedRequest): string | null {
  return req.identity?.user_id ?? null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function isoOrNull(v: unknown): string | null {
  const s = str(v);
  return s && ISO_RE.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

function dbOr500(res: Response) {
  const sb = getSupabase();
  if (!sb) res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  return sb;
}

router.get('/spotlight', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  const sb = dbOr500(res);
  if (!sb) return;
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    const scores = await repo.fetchRecentScores(sb, userId, since);
    const movements = await repo.fetchMovementsBetween(sb, userId, `${today}T00:00:00Z`, now.toISOString());
    const latest = scores[scores.length - 1];
    const bf = latest?.feature_inputs?.balance_factor;
    const spotlight = buildSpotlight(scores, movements.filter((m) => (m.score_date || m.at.slice(0, 10)) === today), bf === undefined || bf === null ? null : Number(bf));
    return res.json({ ok: true, spotlight, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] GET /timeline/spotlight failed:`, err?.message);
    return res.status(500).json({ ok: false, error: 'spotlight_failed', vtid: VTID });
  }
});

router.get('/summary', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  const sb = dbOr500(res);
  if (!sb) return;
  try {
    const from = isoOrNull(req.query.from) ?? new Date(Date.now() - 90 * 86_400_000).toISOString();
    const to = isoOrNull(req.query.to);
    let { rows, missingSchema } = await repo.fetchClassifiedRows(sb, { userId, tiers: VISIBLE_TIERS, from, to, limit: 2000 });
    if (missingSchema) rows = (await repo.fetchLegacyRows(sb, { userId, from, to, limit: 2000 })).rows;
    const pillars: Record<string, number> = Object.fromEntries(PILLAR_KEYS.map((p) => [p, 0]));
    const categories: Record<string, number> = {};
    const days: Record<string, number> = {};
    for (const r of rows) {
      const c = classifyRow(r);
      if (!VISIBLE_TIERS.includes(c.tier)) continue;
      if (c.pillar) pillars[c.pillar] += 1;
      if (c.secondary_pillar && c.secondary_pillar !== c.pillar) pillars[c.secondary_pillar] += 1;
      categories[c.category] = (categories[c.category] ?? 0) + 1;
      const d = r.created_at.slice(0, 10);
      days[d] = (days[d] ?? 0) + 1;
    }
    return res.json({ ok: true, summary: { from, to, pillars, categories, days }, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] GET /timeline/summary failed:`, err?.message);
    return res.status(500).json({ ok: false, error: 'summary_failed', vtid: VTID });
  }
});

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  const pillar = str(req.query.pillar);
  if (pillar && !(PILLAR_KEYS as readonly string[]).includes(pillar)) {
    return res.status(400).json({ ok: false, error: 'invalid_pillar', vtid: VTID });
  }
  const category = str(req.query.category);
  if (category && !CATEGORIES.has(category)) {
    return res.status(400).json({ ok: false, error: 'invalid_category', vtid: VTID });
  }
  const before = isoOrNull(req.query.cursor);
  const from = isoOrNull(req.query.from);
  const to = isoOrNull(req.query.to);
  const q = str(req.query.q)?.slice(0, 60) ?? null;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
  const sb = dbOr500(res);
  if (!sb) return;
  try {
    let { rows, missingSchema } = await repo.fetchClassifiedRows(sb, { userId, tiers: VISIBLE_TIERS, before, from, to, pillar, category, q, limit });
    let digestRows: repo.ActivityRow[] = [];
    if (missingSchema) {
      // Before VTID-05167 is applied: classify in process from the same catalog.
      const legacy = (await repo.fetchLegacyRows(sb, { userId, before, from, to, limit: limit * 6 })).rows;
      digestRows = legacy;
      rows = legacy
        .filter((r) => {
          const c = classifyRow(r);
          if (!VISIBLE_TIERS.includes(c.tier)) return false;
          if (pillar && c.pillar !== pillar && c.secondary_pillar !== pillar) return false;
          if (category && c.category !== category) return false;
          if (q && !`${r.activity_type} ${c.topic} ${c.category}`.toLowerCase().includes(q.toLowerCase())) return false;
          return true;
        })
        .slice(0, limit);
    }
    const nextCursor = rows.length === limit ? rows[rows.length - 1].created_at : null;
    // The day window this page covers: Index day cards and digests only for those days.
    const windowTo = before ?? to ?? new Date().toISOString();
    const windowFrom = rows.length ? `${rows[rows.length - 1].created_at.slice(0, 10)}T00:00:00Z` : from ?? windowTo;
    const filtered = !!(pillar || category || q);

    const ids = rows
      .map((r) => (typeof r.activity_data?.movement_id === 'string' ? (r.activity_data.movement_id as string) : null))
      .filter((x): x is string => !!x);
    const [byIdList, windowMovements] = await Promise.all([
      repo.fetchMovementsByIds(sb, userId, ids),
      repo.fetchMovementsBetween(sb, userId, windowFrom, windowTo),
    ]);
    const byId = new Map(byIdList.map((m) => [m.id, m]));
    const moments = rows.map((r) => toMoment(r, movementFor(r, byId, windowMovements)));

    let dayCards = filtered && category !== 'index' ? [] : buildIndexDayCards(windowMovements);
    if (pillar) dayCards = buildIndexDayCards(windowMovements).filter((c) => (c.delta_pillars as Record<string, number>)[pillar]);
    if (!missingSchema && !filtered) {
      const d = await repo.fetchClassifiedRows(sb, { userId, tiers: ['digest'], before, from: windowFrom, to: windowTo, limit: 500 });
      digestRows = d.rows;
    }
    const digests = filtered ? [] : buildDayDigests(digestRows);
    return res.json({ ok: true, items: mergeItems(moments, dayCards, digests), next_cursor: nextCursor, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] GET /timeline failed:`, err?.message);
    return res.status(500).json({ ok: false, error: 'timeline_failed', vtid: VTID });
  }
});

// ---------------------------------------------------------------------------
// VTID-05171 — learning switches and the member's usage data. Declared before
// '/:id' so the paths are never read as an id.
// ---------------------------------------------------------------------------
const VTID_P5 = 'VTID-05171';
const USAGE_EXPORT_LIMIT = 10_000;

router.get('/learning-prefs', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID_P5 });
  const sb = dbOr500(res);
  if (!sb) return;
  const prefs = await fetchLearningPrefs(sb, userId);
  return res.json({
    ok: true,
    available: prefs.available,
    prefs: LEARNABLE_CATEGORIES.map((category) => ({ category, learn: !prefs.off.has(category) })),
    vtid: VTID_P5,
  });
});

router.put('/learning-prefs', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: the member's own privacy action on their own rows; an OASIS event would keep a trace of what they hid or deleted.
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID_P5 });
  const { category, learn } = req.body ?? {};
  if (!isLearnableCategory(category)) return res.status(400).json({ ok: false, error: 'invalid_category', vtid: VTID_P5 });
  if (typeof learn !== 'boolean') return res.status(400).json({ ok: false, error: 'learn_must_be_boolean', vtid: VTID_P5 });
  const sb = dbOr500(res);
  if (!sb) return;
  const r = await setLearningPref(sb, userId, category, learn);
  if (!r.ok) {
    return r.reason === 'unavailable'
      ? res.status(409).json({ ok: false, error: 'not_available_yet', vtid: VTID_P5 })
      : res.status(500).json({ ok: false, error: 'save_failed', vtid: VTID_P5 });
  }
  return res.json({ ok: true, category, learn, routines_deleted: r.routines_deleted, vtid: VTID_P5 });
});

router.get('/usage-data', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID_P5 });
  const sb = dbOr500(res);
  if (!sb) return;
  const r = await repo.countUsageRows(sb, userId);
  if (r.error) return res.status(500).json({ ok: false, error: 'usage_count_failed', vtid: VTID_P5 });
  return res.json({ ok: true, available: !r.missingSchema, count: r.count, vtid: VTID_P5 });
});

router.get('/usage-data/export', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID_P5 });
  const sb = dbOr500(res);
  if (!sb) return;
  const r = await repo.fetchUsageRows(sb, userId, USAGE_EXPORT_LIMIT);
  if (r.missingSchema) return res.status(409).json({ ok: false, error: 'not_available_yet', vtid: VTID_P5 });
  if (r.error) return res.status(500).json({ ok: false, error: 'usage_export_failed', vtid: VTID_P5 });
  res.setHeader('Content-Disposition', 'attachment; filename="vitana-usage-data.json"');
  return res.json({ ok: true, exported_at: new Date().toISOString(), truncated: r.rows.length >= USAGE_EXPORT_LIMIT, rows: r.rows, vtid: VTID_P5 });
});

router.delete('/usage-data', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: the member's own privacy action on their own rows; an OASIS event would keep a trace of what they hid or deleted.
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID_P5 });
  const sb = dbOr500(res);
  if (!sb) return;
  const r = await repo.deleteUsageRows(sb, userId);
  if (r.missingSchema) return res.status(409).json({ ok: false, error: 'not_available_yet', vtid: VTID_P5 });
  if (r.error) return res.status(500).json({ ok: false, error: 'usage_delete_failed', vtid: VTID_P5 });
  // What was learned from it goes too.
  const routines = await sb.from('user_routines').delete({ count: 'exact' }).eq('user_id', userId).in('routine_kind', [...APP_USAGE_ROUTINE_KINDS]);
  return res.json({ ok: true, deleted: r.deleted, routines_deleted: routines.error ? 0 : routines.count ?? 0, vtid: VTID_P5 });
});

router.get('/routines', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID_P5 });
  const sb = dbOr500(res);
  if (!sb) return;
  const { data, error } = await sb
    .from('user_routines')
    .select('id, routine_kind, routine_key, metadata, confidence, evidence_count, last_observed')
    .eq('user_id', userId)
    .gte('confidence', 0.5)
    .order('confidence', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ ok: false, error: 'routines_failed', vtid: VTID_P5 });
  // The app renders each routine from kind + metadata in the member's language;
  // the English title/summary are for the model only and are not sent.
  return res.json({ ok: true, routines: data ?? [], vtid: VTID_P5 });
});

router.delete('/routines/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: the member's own privacy action on their own rows; an OASIS event would keep a trace of what they hid or deleted.
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID_P5 });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id', vtid: VTID_P5 });
  const sb = dbOr500(res);
  if (!sb) return;
  const { error, count } = await sb.from('user_routines').delete({ count: 'exact' }).eq('user_id', userId).eq('id', req.params.id);
  if (error) return res.status(500).json({ ok: false, error: 'forget_failed', vtid: VTID_P5 });
  if (!count) return res.status(404).json({ ok: false, error: 'not_found', vtid: VTID_P5 });
  return res.json({ ok: true, id: req.params.id, vtid: VTID_P5 });
});

router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id', vtid: VTID });
  const sb = dbOr500(res);
  if (!sb) return;
  try {
    const { row } = await repo.fetchRowById(sb, userId, req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found', vtid: VTID });
    const c = classifyRow(row);
    if (c.tier === 'system' || c.tier === 'silent') return res.status(404).json({ ok: false, error: 'not_found', vtid: VTID });
    const mid = typeof row.activity_data?.movement_id === 'string' ? (row.activity_data.movement_id as string) : null;
    const movements = mid ? await repo.fetchMovementsByIds(sb, userId, [mid]) : [];
    const movement = movements[0] ?? null;
    const item = toMoment(row, movement);
    return res.json({
      ok: true,
      item,
      detail: {
        index_before: movement?.before ?? null,
        index_after: movement?.after ?? null,
        used_by_vitana: !item.hidden_from_ai,
        why_kept_key: `timeline.why_kept.${c.tier}`,
      },
      vtid: VTID,
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /timeline/:id failed:`, err?.message);
    return res.status(500).json({ ok: false, error: 'item_failed', vtid: VTID });
  }
});

router.post('/:id/hide-from-ai', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: the member's own privacy action on their own rows; an OASIS event would keep a trace of what they hid or deleted.
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id', vtid: VTID });
  if (typeof req.body?.hidden !== 'boolean') return res.status(400).json({ ok: false, error: 'hidden_must_be_boolean', vtid: VTID });
  const sb = dbOr500(res);
  if (!sb) return;
  const r = await repo.setHiddenFromAi(sb, userId, req.params.id, req.body.hidden);
  if (r.missingSchema) return res.status(409).json({ ok: false, error: 'not_available_yet', vtid: VTID });
  if (r.error) return res.status(500).json({ ok: false, error: 'hide_failed', vtid: VTID });
  if (!r.found) return res.status(404).json({ ok: false, error: 'not_found', vtid: VTID });
  return res.json({ ok: true, id: req.params.id, hidden_from_ai: req.body.hidden, vtid: VTID });
});

router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: the member's own privacy action on their own rows; an OASIS event would keep a trace of what they hid or deleted.
  const userId = userOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id', vtid: VTID });
  const sb = dbOr500(res);
  if (!sb) return;
  const r = await repo.deleteRow(sb, userId, req.params.id);
  if (r.error) return res.status(500).json({ ok: false, error: 'delete_failed', vtid: VTID });
  if (!r.found) return res.status(404).json({ ok: false, error: 'not_found', vtid: VTID });
  return res.json({ ok: true, id: req.params.id, vtid: VTID });
});

export default router;
