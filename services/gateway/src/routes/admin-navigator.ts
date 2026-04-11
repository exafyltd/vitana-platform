/**
 * VTID-NAV-02: Admin Navigator API
 *
 * CRUD + simulation + coverage + telemetry for the Vitana Navigator catalog.
 * Every endpoint is gated on exafy_admin. All writes emit an audit row so
 * admins can revert.
 *
 * Mounted at /api/v1/admin/navigator. The React admin UI in vitana-v1 is
 * the only consumer.
 *
 * Endpoints:
 *   GET    /catalog                     — list (optional ?tenant_id, ?category, ?q, ?lang)
 *   GET    /catalog/:id                 — one entry + recent audit history
 *   POST   /catalog                     — create (writes audit)
 *   PATCH  /catalog/:id                 — update (writes audit)
 *   DELETE /catalog/:id                 — soft delete (writes audit)
 *   POST   /catalog/:id/restore/:audit  — restore a prior version (writes audit)
 *   POST   /simulate                    — run the real consult pipeline against an utterance
 *   GET    /spa-routes                  — canonical list of React Router paths (cross-tenant)
 *   GET    /coverage                    — SPA routes ↔ catalog coverage diff
 *   GET    /telemetry                   — 7/30-day aggregates from oasis_events
 *   POST   /reload                      — force cache refresh (dev convenience)
 *
 * IMPORTANT: /spa-routes reads the build-time generated JSON shipped with
 * vitana-v1 (scripts/extract-routes.ts → src/generated/spa-routes.json). The
 * gateway does not yet bundle vitana-v1, so this endpoint currently returns
 * a hard-coded fallback derived from App.tsx; once the gateway picks up the
 * generated file at deploy time it will auto-upgrade.
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  refreshNavCatalogCache,
  invalidateNavCatalogCache,
  getCatalogForTenant,
  NavCatalogEntryWithRules,
} from '../lib/nav-catalog-db';
import { consultNavigator, type NavigatorConsultInput } from '../services/navigator-consult';
import { SPA_ROUTES_FALLBACK } from '../lib/spa-routes-fallback';

const router = Router();
const VTID = 'VTID-NAV-02';

// ── Auth helper ─────────────────────────────────────────────────────────────

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

async function verifyExafyAdmin(
  req: Request
): Promise<{ ok: true; user_id: string; email: string } | { ok: false; status: number; error: string }> {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'UNAUTHENTICATED' };
  try {
    const userClient = createUserSupabaseClient(token);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) return { ok: false, status: 401, error: 'INVALID_TOKEN' };
    const appMetadata = authData.user.app_metadata || {};
    if (appMetadata.exafy_admin !== true) {
      return { ok: false, status: 403, error: 'FORBIDDEN' };
    }
    return { ok: true, user_id: authData.user.id, email: authData.user.email || 'unknown' };
  } catch (err: any) {
    console.error(`[${VTID}] Auth error:`, err.message);
    return { ok: false, status: 500, error: 'INTERNAL_ERROR' };
  }
}

// ── Validation helpers ──────────────────────────────────────────────────────

const VALID_CATEGORIES = [
  'public', 'auth', 'community', 'business', 'wallet', 'health',
  'discover', 'home', 'memory', 'ai', 'inbox', 'settings',
] as const;

const VALID_ACCESS = ['public', 'authenticated'] as const;

function validateCatalogPayload(body: any, { isPartial }: { isPartial: boolean }): string | null {
  if (!body || typeof body !== 'object') return 'PAYLOAD_REQUIRED';

  if (!isPartial) {
    if (typeof body.screen_id !== 'string' || body.screen_id.trim() === '') {
      return 'screen_id required';
    }
    if (typeof body.route !== 'string' || !body.route.startsWith('/')) {
      return 'route must be a string starting with /';
    }
    if (!VALID_CATEGORIES.includes(body.category)) {
      return 'category invalid';
    }
    if (!VALID_ACCESS.includes(body.access)) {
      return 'access invalid';
    }
    if (!body.i18n || typeof body.i18n !== 'object' || !body.i18n.en) {
      return 'i18n.en required (at least title + when_to_visit)';
    }
    if (!body.i18n.en.title || !body.i18n.en.when_to_visit) {
      return 'i18n.en must include title and when_to_visit';
    }
  } else {
    if (body.category && !VALID_CATEGORIES.includes(body.category)) return 'category invalid';
    if (body.access && !VALID_ACCESS.includes(body.access)) return 'access invalid';
    if (body.route && (typeof body.route !== 'string' || !body.route.startsWith('/'))) {
      return 'route must start with /';
    }
  }

  if (body.priority != null && (typeof body.priority !== 'number' || body.priority < 0 || body.priority > 10)) {
    return 'priority must be a number 0..10';
  }
  if (body.related_kb_topics && !Array.isArray(body.related_kb_topics)) {
    return 'related_kb_topics must be an array';
  }
  if (body.context_rules && typeof body.context_rules !== 'object') {
    return 'context_rules must be an object';
  }
  if (body.override_triggers && !Array.isArray(body.override_triggers)) {
    return 'override_triggers must be an array';
  }
  if (Array.isArray(body.override_triggers)) {
    for (const trig of body.override_triggers) {
      if (!trig || typeof trig !== 'object') return 'override_triggers entries must be objects';
      if (typeof trig.phrase !== 'string' || typeof trig.lang !== 'string') {
        return 'override_triggers entries require phrase + lang';
      }
    }
  }
  return null;
}

async function writeAudit(args: {
  catalog_id: string | null;
  screen_id: string | null;
  tenant_id: string | null;
  action: 'create' | 'update' | 'delete' | 'restore';
  before: any;
  after: any;
  actor_user_id: string;
  actor_email: string;
}): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from('nav_catalog_audit').insert({
    catalog_id: args.catalog_id,
    screen_id: args.screen_id,
    tenant_id: args.tenant_id,
    action: args.action,
    before: args.before,
    after: args.after,
    actor_user_id: args.actor_user_id,
    actor_email: args.actor_email,
  });
  if (error) console.warn(`[${VTID}] audit insert failed: ${error.message}`);
}

// ── GET /catalog ────────────────────────────────────────────────────────────

router.get('/catalog', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { tenant_id, category, q, lang: langQ, include_inactive } = req.query;

  try {
    let query = supabase
      .from('nav_catalog')
      .select('id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active, created_at, updated_at, updated_by');

    if (include_inactive !== 'true') query = query.eq('is_active', true);
    if (category && typeof category === 'string') query = query.eq('category', category);
    if (tenant_id && typeof tenant_id === 'string') {
      if (tenant_id === '__shared__' || tenant_id === 'null') {
        query = query.is('tenant_id', null);
      } else {
        query = query.eq('tenant_id', tenant_id);
      }
    }

    const { data: rows, error } = await query.order('category').order('screen_id');
    if (error) return res.status(500).json({ ok: false, error: error.message });

    const catalogIds = (rows || []).map((r: any) => r.id);
    let i18nByCatalog: Record<string, any[]> = {};
    if (catalogIds.length > 0) {
      const { data: i18nRows } = await supabase
        .from('nav_catalog_i18n')
        .select('catalog_id, lang, title, description, when_to_visit, updated_at')
        .in('catalog_id', catalogIds);
      for (const r of (i18nRows as any[]) || []) {
        (i18nByCatalog[r.catalog_id] ||= []).push(r);
      }
    }

    let merged = (rows || []).map((r: any) => ({ ...r, i18n: i18nByCatalog[r.id] || [] }));

    // Optional free-text filter against english title + when_to_visit.
    if (q && typeof q === 'string') {
      const needle = q.toLowerCase();
      merged = merged.filter((r: any) => {
        const en = (r.i18n || []).find((x: any) => x.lang === 'en');
        if (!en) return false;
        return (en.title || '').toLowerCase().includes(needle) ||
               (en.when_to_visit || '').toLowerCase().includes(needle);
      });
    }

    return res.json({ ok: true, data: merged, count: merged.length });
  } catch (err: any) {
    console.error(`[${VTID}] GET /catalog:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /catalog/:id ────────────────────────────────────────────────────────

router.get('/catalog/:id', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { id } = req.params;
  try {
    const { data: row, error } = await supabase
      .from('nav_catalog')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const { data: i18nRows } = await supabase
      .from('nav_catalog_i18n')
      .select('*')
      .eq('catalog_id', id);

    const { data: auditRows } = await supabase
      .from('nav_catalog_audit')
      .select('*')
      .eq('catalog_id', id)
      .order('created_at', { ascending: false })
      .limit(50);

    return res.json({
      ok: true,
      data: { ...row, i18n: i18nRows || [] },
      audit: auditRows || [],
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /catalog/:id:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /catalog ───────────────────────────────────────────────────────────

router.post('/catalog', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const err = validateCatalogPayload(req.body, { isPartial: false });
  if (err) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: err });

  try {
    const insertRow: any = {
      screen_id: req.body.screen_id.trim(),
      tenant_id: req.body.tenant_id || null,
      route: req.body.route.trim(),
      category: req.body.category,
      access: req.body.access,
      anonymous_safe: !!req.body.anonymous_safe,
      priority: req.body.priority || 0,
      related_kb_topics: req.body.related_kb_topics || [],
      context_rules: req.body.context_rules || {},
      override_triggers: req.body.override_triggers || [],
      is_active: true,
      updated_by: auth.user_id,
    };

    const { data: created, error: insertErr } = await supabase
      .from('nav_catalog')
      .insert(insertRow)
      .select('*')
      .single();

    if (insertErr) {
      // Unique index violation → friendly message for the admin UI.
      if (insertErr.code === '23505') {
        return res.status(409).json({ ok: false, error: 'SCREEN_ID_CONFLICT', message: insertErr.message });
      }
      return res.status(500).json({ ok: false, error: insertErr.message });
    }

    // i18n rows
    const i18nRows = Object.entries(req.body.i18n || {}).map(([lang, c]: [string, any]) => ({
      catalog_id: created.id,
      lang,
      title: c.title || '',
      description: c.description || '',
      when_to_visit: c.when_to_visit || '',
    }));
    if (i18nRows.length > 0) {
      const { error: i18nErr } = await supabase.from('nav_catalog_i18n').insert(i18nRows);
      if (i18nErr) console.warn(`[${VTID}] i18n insert after create: ${i18nErr.message}`);
    }

    await writeAudit({
      catalog_id: created.id,
      screen_id: created.screen_id,
      tenant_id: created.tenant_id,
      action: 'create',
      before: null,
      after: { ...created, i18n: i18nRows },
      actor_user_id: auth.user_id,
      actor_email: auth.email,
    });

    invalidateNavCatalogCache();
    return res.json({ ok: true, data: { ...created, i18n: i18nRows } });
  } catch (err: any) {
    console.error(`[${VTID}] POST /catalog:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── PATCH /catalog/:id ──────────────────────────────────────────────────────

router.patch('/catalog/:id', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const err = validateCatalogPayload(req.body, { isPartial: true });
  if (err) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: err });

  const { id } = req.params;
  try {
    const { data: existing } = await supabase.from('nav_catalog').select('*').eq('id', id).maybeSingle();
    if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const { data: existingI18n } = await supabase.from('nav_catalog_i18n').select('*').eq('catalog_id', id);

    const patch: any = { updated_by: auth.user_id };
    for (const key of ['route', 'category', 'access', 'anonymous_safe', 'priority', 'related_kb_topics', 'context_rules', 'override_triggers', 'is_active']) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }

    const { data: updated, error: updErr } = await supabase
      .from('nav_catalog')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();

    if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

    // Upsert i18n rows if provided.
    let newI18n = existingI18n || [];
    if (req.body.i18n && typeof req.body.i18n === 'object') {
      const upserts = Object.entries(req.body.i18n).map(([lang, c]: [string, any]) => ({
        catalog_id: id,
        lang,
        title: c.title || '',
        description: c.description || '',
        when_to_visit: c.when_to_visit || '',
      }));
      if (upserts.length > 0) {
        const { error: upErr } = await supabase
          .from('nav_catalog_i18n')
          .upsert(upserts, { onConflict: 'catalog_id,lang' });
        if (upErr) console.warn(`[${VTID}] i18n upsert: ${upErr.message}`);
      }
      const { data: refreshed } = await supabase.from('nav_catalog_i18n').select('*').eq('catalog_id', id);
      newI18n = refreshed || newI18n;
    }

    await writeAudit({
      catalog_id: id,
      screen_id: updated.screen_id,
      tenant_id: updated.tenant_id,
      action: 'update',
      before: { ...existing, i18n: existingI18n },
      after: { ...updated, i18n: newI18n },
      actor_user_id: auth.user_id,
      actor_email: auth.email,
    });

    invalidateNavCatalogCache();
    return res.json({ ok: true, data: { ...updated, i18n: newI18n } });
  } catch (err: any) {
    console.error(`[${VTID}] PATCH /catalog/:id:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── DELETE /catalog/:id (soft) ──────────────────────────────────────────────

router.delete('/catalog/:id', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { id } = req.params;
  try {
    const { data: existing } = await supabase.from('nav_catalog').select('*').eq('id', id).maybeSingle();
    if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const { data: updated, error: updErr } = await supabase
      .from('nav_catalog')
      .update({ is_active: false, updated_by: auth.user_id })
      .eq('id', id)
      .select('*')
      .single();
    if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

    await writeAudit({
      catalog_id: id,
      screen_id: existing.screen_id,
      tenant_id: existing.tenant_id,
      action: 'delete',
      before: existing,
      after: updated,
      actor_user_id: auth.user_id,
      actor_email: auth.email,
    });

    invalidateNavCatalogCache();
    return res.json({ ok: true });
  } catch (err: any) {
    console.error(`[${VTID}] DELETE /catalog/:id:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /catalog/:id/restore/:audit_id ─────────────────────────────────────

router.post('/catalog/:id/restore/:audit_id', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { id, audit_id } = req.params;
  try {
    const { data: audit } = await supabase
      .from('nav_catalog_audit')
      .select('*')
      .eq('id', audit_id)
      .eq('catalog_id', id)
      .maybeSingle();
    if (!audit) return res.status(404).json({ ok: false, error: 'AUDIT_NOT_FOUND' });

    // The snapshot we restore to depends on action:
    //   - 'update' / 'delete': restore to audit.before (state pre-change)
    //   - 'create': effectively re-activate with audit.after
    const snapshot = audit.action === 'create' ? audit.after : audit.before;
    if (!snapshot) return res.status(400).json({ ok: false, error: 'NO_SNAPSHOT' });

    const patch: any = {
      route: snapshot.route,
      category: snapshot.category,
      access: snapshot.access,
      anonymous_safe: snapshot.anonymous_safe,
      priority: snapshot.priority || 0,
      related_kb_topics: snapshot.related_kb_topics || [],
      context_rules: snapshot.context_rules || {},
      override_triggers: snapshot.override_triggers || [],
      is_active: true,
      updated_by: auth.user_id,
    };

    const { data: existing } = await supabase.from('nav_catalog').select('*').eq('id', id).maybeSingle();

    const { data: updated, error: updErr } = await supabase
      .from('nav_catalog').update(patch).eq('id', id).select('*').single();
    if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

    // Restore i18n too if snapshot has it.
    if (Array.isArray(snapshot.i18n) && snapshot.i18n.length > 0) {
      const upserts = snapshot.i18n.map((r: any) => ({
        catalog_id: id,
        lang: r.lang,
        title: r.title || '',
        description: r.description || '',
        when_to_visit: r.when_to_visit || '',
      }));
      await supabase.from('nav_catalog_i18n').upsert(upserts, { onConflict: 'catalog_id,lang' });
    }

    await writeAudit({
      catalog_id: id,
      screen_id: updated.screen_id,
      tenant_id: updated.tenant_id,
      action: 'restore',
      before: existing,
      after: updated,
      actor_user_id: auth.user_id,
      actor_email: auth.email,
    });

    invalidateNavCatalogCache();
    return res.json({ ok: true, data: updated });
  } catch (err: any) {
    console.error(`[${VTID}] POST /catalog/:id/restore:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /simulate ──────────────────────────────────────────────────────────

router.post('/simulate', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const { utterance, lang, current_route, recent_routes, is_anonymous, tenant_id, user_id } = req.body || {};
  if (typeof utterance !== 'string' || utterance.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'utterance required' });
  }

  try {
    const input: NavigatorConsultInput = {
      question: utterance,
      lang: (lang as string) || 'en',
      identity: tenant_id
        ? { user_id: user_id || auth.user_id, tenant_id, role: 'admin' }
        : null,
      is_anonymous: !!is_anonymous,
      current_route: typeof current_route === 'string' ? current_route : undefined,
      recent_routes: Array.isArray(recent_routes) ? recent_routes : [],
      session_id: `admin-sim-${Date.now()}`,
      turn_number: 0,
      conversation_start: new Date().toISOString(),
    };

    const result = await consultNavigator(input);
    return res.json({ ok: true, input, result });
  } catch (err: any) {
    console.error(`[${VTID}] POST /simulate:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── GET /spa-routes ─────────────────────────────────────────────────────────

router.get('/spa-routes', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  // Static fallback shipped with the gateway. The build-time extract from
  // vitana-v1 (scripts/extract-routes.ts) will replace this when CI wires it.
  return res.json({ ok: true, source: 'gateway_fallback', routes: SPA_ROUTES_FALLBACK });
});

// ── GET /coverage ───────────────────────────────────────────────────────────

router.get('/coverage', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const tenantId = typeof req.query.tenant_id === 'string' ? req.query.tenant_id : null;

  try {
    const catalog: NavCatalogEntryWithRules[] = getCatalogForTenant(tenantId) as NavCatalogEntryWithRules[];
    const catalogRoutes = new Set(catalog.map(e => e.route));
    const spaRoutes = SPA_ROUTES_FALLBACK.map(r => r.path);
    const spaSet = new Set(spaRoutes);

    const missing_in_catalog = spaRoutes
      .filter(r => !catalogRoutes.has(r) && !r.includes(':') && r !== '*')
      .map(r => {
        const def = SPA_ROUTES_FALLBACK.find(x => x.path === r);
        return { route: r, requires_auth: def?.requires_auth || false };
      });

    const broken_catalog_routes = catalog
      .filter(e => {
        // Allow params like /discover/product/:id → match against the matching pattern
        // by stripping trailing params. The fallback list stores the literal patterns.
        return !spaSet.has(e.route);
      })
      .map(e => ({ screen_id: e.screen_id, route: e.route, title: e.i18n.en?.title || e.screen_id }));

    // Dead triggers: screens that never produced a catalog match in the last
    // 30 days. We detect those via OASIS navigator events.
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: events } = await supabase
      .from('oasis_events_v1')
      .select('payload, type, created_at')
      .like('type', 'orb.navigator.%')
      .gte('created_at', since)
      .limit(10000);

    const firedScreenIds = new Set<string>();
    for (const ev of (events as any[]) || []) {
      const payload = (ev.payload || {}) as any;
      const picks: any[] = payload.top_picks || (payload.primary ? [payload.primary] : []);
      for (const p of picks) if (p?.screen_id) firedScreenIds.add(p.screen_id);
    }

    const dead_triggers = catalog
      .filter(e => !firedScreenIds.has(e.screen_id))
      .map(e => ({ screen_id: e.screen_id, title: e.i18n.en?.title || e.screen_id, route: e.route }));

    return res.json({
      ok: true,
      tenant_id: tenantId,
      summary: {
        catalog_size: catalog.length,
        spa_route_count: spaRoutes.length,
        missing_in_catalog: missing_in_catalog.length,
        broken_catalog_routes: broken_catalog_routes.length,
        dead_triggers: dead_triggers.length,
      },
      missing_in_catalog,
      broken_catalog_routes,
      dead_triggers,
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /coverage:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /telemetry ──────────────────────────────────────────────────────────

router.get('/telemetry', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const days = Math.min(parseInt((req.query.days as string) || '30', 10) || 30, 90);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const { data: events, error } = await supabase
      .from('oasis_events_v1')
      .select('type, payload, created_at')
      .like('type', 'orb.navigator.%')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) return res.status(500).json({ ok: false, error: error.message });

    const byType: Record<string, number> = {};
    const byScreen: Record<string, number> = {};
    const failedUtterances: Array<{ utterance: string; confidence: string; top_picks?: any[] }> = [];
    const nearMisses: Array<{ utterance: string; picked: any; runner_up: any; delta: number }> = [];

    for (const ev of (events as any[]) || []) {
      byType[ev.type] = (byType[ev.type] || 0) + 1;
      const payload = (ev.payload || {}) as any;
      const picks: any[] = payload.top_picks || (payload.primary ? [payload.primary] : []);
      for (const p of picks) {
        if (p?.screen_id) byScreen[p.screen_id] = (byScreen[p.screen_id] || 0) + 1;
      }
      if (payload.confidence === 'low' && payload.question) {
        failedUtterances.push({ utterance: payload.question, confidence: payload.confidence, top_picks: picks });
      }
      if (Array.isArray(picks) && picks.length >= 2) {
        const [a, b] = picks;
        if (a?.score != null && b?.score != null) {
          const delta = a.score - b.score;
          if (delta >= 0 && delta <= 4) {
            nearMisses.push({ utterance: payload.question || '', picked: a, runner_up: b, delta });
          }
        }
      }
    }

    const topScreens = Object.entries(byScreen)
      .map(([screen_id, count]) => ({ screen_id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    return res.json({
      ok: true,
      days,
      event_count: (events || []).length,
      by_type: byType,
      top_screens: topScreens,
      failed_utterances: failedUtterances.slice(0, 50),
      near_misses: nearMisses.slice(0, 50),
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /telemetry:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /reload ────────────────────────────────────────────────────────────

router.post('/reload', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    await refreshNavCatalogCache();
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
