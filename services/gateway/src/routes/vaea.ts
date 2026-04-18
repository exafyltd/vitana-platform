/**
 * VTID-02402: VAEA Phase 1.5 — read + CRUD routes for the Business Hub.
 *
 * Wraps the four VAEA tables (config, catalog, channels, detected questions,
 * drafts) behind tenant-scoped REST endpoints so a future Business Hub panel
 * in vitana-v1 can let users:
 *   - flip the three switches + autonomy default
 *   - curate their referral catalog
 *   - register / pause listener channels
 *   - review what VAEA detected and what it would have said
 *   - dismiss a shadow draft they don't like
 *
 * Zero posting. Zero mesh. All writes scoped to the authenticated user;
 * RLS on the tables is defense-in-depth.
 *
 * Mounted at: /api/v1/vaea
 */

import { Router, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();
const VTID = 'VTID-02402';

router.use(requireAuth);

function requireUserTenant(
  req: AuthenticatedRequest,
  res: Response,
): { user_id: string; tenant_id: string } | null {
  const user_id = req.identity?.user_id;
  const tenant_id = req.identity?.tenant_id;
  if (!user_id || !tenant_id) {
    res.status(400).json({ ok: false, error: 'MISSING_TENANT', message: 'Active tenant required' });
    return null;
  }
  return { user_id, tenant_id };
}

function supabaseOrFail(res: Response): ReturnType<typeof getSupabase> | null {
  const sb = getSupabase();
  if (!sb) {
    res.status(503).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });
    return null;
  }
  return sb;
}

// ─── CONFIG ────────────────────────────────────────────────────────────────

router.get('/config', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const { data, error } = await sb
    .from('vaea_config')
    .select('*')
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .maybeSingle();

  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  res.json({ ok: true, config: data || null });
});

router.put('/config', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const body = req.body || {};
  const payload: Record<string, unknown> = {
    tenant_id: ident.tenant_id,
    user_id: ident.user_id,
  };

  const bools = ['receive_recommendations', 'give_recommendations', 'make_money_goal'] as const;
  for (const k of bools) if (typeof body[k] === 'boolean') payload[k] = body[k];

  if (typeof body.autonomy_default === 'string') {
    const allowed = ['silent', 'draft_to_user', 'one_tap_approve', 'auto_post'];
    if (!allowed.includes(body.autonomy_default)) {
      res.status(400).json({ ok: false, error: 'INVALID_AUTONOMY' });
      return;
    }
    payload.autonomy_default = body.autonomy_default;
  }

  if (body.autonomy_by_channel && typeof body.autonomy_by_channel === 'object') {
    payload.autonomy_by_channel = body.autonomy_by_channel;
  }
  if (Array.isArray(body.voice_samples)) payload.voice_samples = body.voice_samples;
  if (typeof body.disclosure_text === 'string') payload.disclosure_text = body.disclosure_text;
  if (Array.isArray(body.expertise_zones)) payload.expertise_zones = body.expertise_zones;
  if (Array.isArray(body.excluded_categories)) payload.excluded_categories = body.excluded_categories;
  if (Array.isArray(body.blocked_counterparties)) payload.blocked_counterparties = body.blocked_counterparties;
  if (typeof body.max_replies_per_day === 'number') payload.max_replies_per_day = body.max_replies_per_day;
  if (typeof body.min_minutes_between_replies === 'number') payload.min_minutes_between_replies = body.min_minutes_between_replies;
  if (typeof body.mesh_scope === 'string') {
    if (!['maxina_only', 'open'].includes(body.mesh_scope)) {
      res.status(400).json({ ok: false, error: 'INVALID_MESH_SCOPE' });
      return;
    }
    payload.mesh_scope = body.mesh_scope;
  }

  const { data, error } = await sb
    .from('vaea_config')
    .upsert(payload, { onConflict: 'tenant_id,user_id' })
    .select('*')
    .single();

  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  res.json({ ok: true, config: data });
});

// ─── CATALOG ───────────────────────────────────────────────────────────────

router.get('/catalog', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const { data, error } = await sb
    .from('vaea_referral_catalog')
    .select('*')
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .order('tier', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  res.json({ ok: true, items: data || [] });
});

router.post('/catalog', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const b = req.body || {};
  if (typeof b.tier !== 'string' || !['own', 'vetted_partner', 'affiliate_network'].includes(b.tier)) {
    res.status(400).json({ ok: false, error: 'INVALID_TIER' });
    return;
  }
  if (typeof b.title !== 'string' || typeof b.category !== 'string' || typeof b.affiliate_url !== 'string') {
    res.status(400).json({ ok: false, error: 'MISSING_FIELDS', message: 'tier, title, category, affiliate_url required' });
    return;
  }

  const { data, error } = await sb
    .from('vaea_referral_catalog')
    .insert({
      tenant_id: ident.tenant_id,
      user_id: ident.user_id,
      tier: b.tier,
      category: b.category,
      title: b.title,
      description: b.description ?? null,
      affiliate_url: b.affiliate_url,
      affiliate_network: b.affiliate_network ?? null,
      commission_percent: typeof b.commission_percent === 'number' ? b.commission_percent : null,
      personal_note: b.personal_note ?? null,
      vetting_status: typeof b.vetting_status === 'string' && ['unvetted', 'tried', 'endorsed'].includes(b.vetting_status)
        ? b.vetting_status
        : 'unvetted',
      active: typeof b.active === 'boolean' ? b.active : true,
    })
    .select('*')
    .single();

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  res.status(201).json({ ok: true, item: data });
});

router.patch('/catalog/:id', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const b = req.body || {};
  const patch: Record<string, unknown> = {};
  const fields = ['tier', 'category', 'title', 'description', 'affiliate_url', 'affiliate_network', 'personal_note', 'vetting_status', 'active', 'commission_percent'];
  for (const f of fields) if (f in b) patch[f] = b[f];

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: 'NO_FIELDS' });
    return;
  }

  const { data, error } = await sb
    .from('vaea_referral_catalog')
    .update(patch)
    .eq('id', req.params.id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .select('*')
    .maybeSingle();

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  if (!data) { res.status(404).json({ ok: false, error: 'NOT_FOUND' }); return; }
  res.json({ ok: true, item: data });
});

router.delete('/catalog/:id', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const { error } = await sb
    .from('vaea_referral_catalog')
    .delete()
    .eq('id', req.params.id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id);

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  res.json({ ok: true });
});

// ─── CHANNELS ──────────────────────────────────────────────────────────────

router.get('/channels', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const { data, error } = await sb
    .from('vaea_listener_channels')
    .select('*')
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  res.json({ ok: true, channels: data || [] });
});

router.post('/channels', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const b = req.body || {};
  const PLATFORMS = ['maxina', 'slack', 'discord', 'telegram', 'reddit', 'custom'];
  if (typeof b.platform !== 'string' || !PLATFORMS.includes(b.platform)) {
    res.status(400).json({ ok: false, error: 'INVALID_PLATFORM' });
    return;
  }
  if (typeof b.channel_key !== 'string' || b.channel_key.trim() === '') {
    res.status(400).json({ ok: false, error: 'MISSING_CHANNEL_KEY' });
    return;
  }

  const { data, error } = await sb
    .from('vaea_listener_channels')
    .insert({
      tenant_id: ident.tenant_id,
      user_id: ident.user_id,
      platform: b.platform,
      channel_key: b.channel_key,
      display_name: b.display_name ?? null,
      config: typeof b.config === 'object' && b.config !== null ? b.config : {},
      autonomy: typeof b.autonomy === 'string' ? b.autonomy : null,
      active: typeof b.active === 'boolean' ? b.active : true,
      dry_run: typeof b.dry_run === 'boolean' ? b.dry_run : true,
    })
    .select('*')
    .single();

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  res.status(201).json({ ok: true, channel: data });
});

router.patch('/channels/:id', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const b = req.body || {};
  const patch: Record<string, unknown> = {};
  const fields = ['display_name', 'config', 'autonomy', 'active', 'dry_run'];
  for (const f of fields) if (f in b) patch[f] = b[f];

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: 'NO_FIELDS' });
    return;
  }

  const { data, error } = await sb
    .from('vaea_listener_channels')
    .update(patch)
    .eq('id', req.params.id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .select('*')
    .maybeSingle();

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  if (!data) { res.status(404).json({ ok: false, error: 'NOT_FOUND' }); return; }
  res.json({ ok: true, channel: data });
});

router.delete('/channels/:id', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const { error } = await sb
    .from('vaea_listener_channels')
    .delete()
    .eq('id', req.params.id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id);

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  res.json({ ok: true });
});

// ─── DETECTED QUESTIONS (read-only) ────────────────────────────────────────

router.get('/detected-questions', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  const disposition = req.query.disposition as string | undefined;

  let q = sb
    .from('vaea_detected_questions')
    .select('*')
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (disposition) q = q.eq('disposition', disposition);

  const { data, error } = await q;
  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  res.json({ ok: true, questions: data || [], limit, offset });
});

// ─── DRAFTS ────────────────────────────────────────────────────────────────

router.get('/drafts', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  const status = (req.query.status as string) || 'shadow,pending_approval';
  const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);

  const { data, error } = await sb
    .from('vaea_reply_drafts')
    .select('*, vaea_detected_questions(id, message_body, platform, author_handle, message_url, combined_score, extracted_topics)')
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .in('status', statuses)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  res.json({ ok: true, drafts: data || [], limit, offset });
});

router.post('/drafts/:id/dismiss', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const { data, error } = await sb
    .from('vaea_reply_drafts')
    .update({ status: 'dismissed' })
    .eq('id', req.params.id)
    .eq('tenant_id', ident.tenant_id)
    .eq('user_id', ident.user_id)
    .in('status', ['shadow', 'pending_approval'])
    .select('id, status')
    .maybeSingle();

  if (error) { res.status(500).json({ ok: false, error: error.message }); return; }
  if (!data) { res.status(404).json({ ok: false, error: 'NOT_FOUND_OR_TERMINAL' }); return; }
  res.json({ ok: true, draft: data });
});

// ─── SUMMARY (single call for the panel) ───────────────────────────────────

router.get('/summary', async (req: AuthenticatedRequest, res: Response) => {
  const ident = requireUserTenant(req, res);
  if (!ident) return;
  const sb = supabaseOrFail(res);
  if (!sb) return;

  const [configRes, channelsCountRes, catalogCountRes, draftsCountRes, questionsCountRes] = await Promise.all([
    sb.from('vaea_config').select('*').eq('tenant_id', ident.tenant_id).eq('user_id', ident.user_id).maybeSingle(),
    sb.from('vaea_listener_channels').select('id', { count: 'exact', head: true }).eq('tenant_id', ident.tenant_id).eq('user_id', ident.user_id).eq('active', true),
    sb.from('vaea_referral_catalog').select('id', { count: 'exact', head: true }).eq('tenant_id', ident.tenant_id).eq('user_id', ident.user_id).eq('active', true),
    sb.from('vaea_reply_drafts').select('id', { count: 'exact', head: true }).eq('tenant_id', ident.tenant_id).eq('user_id', ident.user_id).in('status', ['shadow', 'pending_approval']),
    sb.from('vaea_detected_questions').select('id', { count: 'exact', head: true }).eq('tenant_id', ident.tenant_id).eq('user_id', ident.user_id).gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  res.json({
    ok: true,
    vtid: VTID,
    config: configRes.data || null,
    counts: {
      active_channels: channelsCountRes.count ?? 0,
      active_catalog_items: catalogCountRes.count ?? 0,
      open_drafts: draftsCountRes.count ?? 0,
      questions_last_7d: questionsCountRes.count ?? 0,
    },
  });
});

export default router;
