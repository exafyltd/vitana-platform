/**
 * Proactive Guide — Did-You-Know route (BOOTSTRAP-DYK-TOUR)
 *
 * Mounted at /api/v1/presence/did-you-know.
 *
 * GET    /                  — resolve next eligible tip for this user
 * POST   /accept            — user accepted (voice or card) → record introduction
 * POST   /decline           — user dismissed (tip|today|stop)
 *
 * Follows the presence.ts pattern: resolveIdentity → flag-check → pacer → business logic → telemetry.
 *
 * Plan: .claude/plans/proactive-did-you-generic-sifakis.md
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  getAwarenessContext,
  canSurfaceProactively,
  recordTouch,
  acknowledgeTouch,
  recordFeatureIntroduction,
  executePauseProactiveGuidance,
  emitGuideTelemetry,
} from '../services/guide';
import { resolveNextTip, getTipByKey } from '../services/guide/tip-curriculum';
import { getSystemControl } from '../services/system-controls-service';

const router = Router();
const FLAG_KEY = 'vitana_did_you_know_enabled';

// =============================================================================
// Identity helper — mirrors presence.ts
// =============================================================================

async function resolveIdentity(req: Request): Promise<{
  user_id: string | null;
  tenant_id: string | null;
  error?: string;
}> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return { user_id: null, tenant_id: null, error: 'no_token' };
  }
  const token = auth.slice(7);
  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');
    if (error || !data) {
      return { user_id: null, tenant_id: null, error: error?.message || 'no_context' };
    }
    const userId = data.user_id || data.id || null;
    let tenantId = data.tenant_id || null;
    // Fallback: me_context returns tenant_id=null for users whose
    // app_metadata.active_tenant_id was never populated, even when a
    // primary user_tenants row exists. Match the behavior of the
    // gateway's requireAuthWithTenant middleware (auth-supabase-jwt.ts).
    if (!tenantId && userId) {
      const { data: tenantRow } = await supabase
        .from('user_tenants')
        .select('tenant_id')
        .eq('user_id', userId)
        .eq('is_primary', true)
        .limit(1)
        .maybeSingle();
      tenantId = tenantRow?.tenant_id || null;
    }
    return { user_id: userId, tenant_id: tenantId };
  } catch (err: any) {
    return { user_id: null, tenant_id: null, error: err.message };
  }
}

async function isFlagEnabled(): Promise<boolean> {
  const control = await getSystemControl(FLAG_KEY);
  return !!control?.enabled;
}

// =============================================================================
// GET / — resolve next tip
// =============================================================================

router.get('/', async (req: Request, res: Response) => {
  const identity = await resolveIdentity(req);
  if (!identity.user_id || !identity.tenant_id) {
    return res.status(401).json({ ok: false, error: identity.error || 'unauthorized' });
  }

  // Flag kill-switch
  if (!(await isFlagEnabled())) {
    return res.json({ ok: true, should_show: false, reason: 'flag_disabled' });
  }

  // Pacer — respects user_proactive_pause, daily cap, same-surface dedup
  const decision = await canSurfaceProactively(identity.user_id, 'did_you_know_card');
  if (!decision.allow) {
    return res.json({
      ok: true,
      should_show: false,
      reason: decision.reason,
      pause: decision.pause ?? null,
    });
  }

  try {
    const awareness = await getAwarenessContext(identity.user_id, identity.tenant_id);
    const tip = resolveNextTip(awareness);

    if (!tip) {
      return res.json({
        ok: true,
        should_show: false,
        reason: 'no_eligible_tip',
        active_usage_days: awareness.tenure.active_usage_days,
      });
    }

    // Record the touch so the pacer counts it against the daily cap
    recordTouch({
      user_id: identity.user_id,
      surface: 'did_you_know_card',
      reason_tag: tip.tip_key,
      metadata: {
        feature_key: tip.feature_key,
        index_pillar_link: tip.index_pillar_link,
        active_usage_days: awareness.tenure.active_usage_days,
      },
    }).catch(() => {});

    emitGuideTelemetry('guide.did_you_know.offered', {
      user_id: identity.user_id,
      tip_key: tip.tip_key,
      feature_key: tip.feature_key,
      index_pillar_link: tip.index_pillar_link,
      active_usage_days: awareness.tenure.active_usage_days,
      tenure_stage: awareness.tenure.stage,
      channel: 'card',
    }).catch(() => {});

    return res.json({
      ok: true,
      should_show: true,
      tip_key: tip.tip_key,
      feature_key: tip.feature_key,
      index_pillar_link: tip.index_pillar_link,
      card_copy: tip.card_copy,
      cta_label: tip.cta_label,
      cta_url: tip.cta_url,
      voice_opener: tip.voice_opener,
      voice_confirm: tip.voice_confirm,
      voice_on_nav: tip.voice_on_nav,
      active_usage_days: awareness.tenure.active_usage_days,
    });
  } catch (err: any) {
    console.error('[presence/did-you-know] error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// POST /accept — user said yes
// =============================================================================

router.post('/accept', async (req: Request, res: Response) => {
  const identity = await resolveIdentity(req);
  if (!identity.user_id) {
    return res.status(401).json({ ok: false, error: identity.error || 'unauthorized' });
  }

  const tipKey = typeof req.body?.tip_key === 'string' ? req.body.tip_key : null;
  const channel =
    req.body?.channel === 'voice' ? 'voice' : req.body?.channel === 'card' ? 'card' : 'card';

  if (!tipKey) {
    return res.status(400).json({ ok: false, error: 'tip_key_required' });
  }

  const tip = getTipByKey(tipKey);
  if (!tip) {
    return res.status(404).json({ ok: false, error: 'tip_not_found' });
  }

  // Mark the surface touch acknowledged
  await acknowledgeTouch({
    user_id: identity.user_id,
    surface: 'did_you_know_card',
    action: 'acknowledged',
  }).catch(() => ({ success: false }));

  // Record the feature introduction so the resolver skips this tip next time
  const introRes = await recordFeatureIntroduction(
    identity.user_id,
    tip.feature_key as string,
    channel === 'voice' ? 'voice' : 'text',
    { tip_key: tip.tip_key, source: 'did_you_know', cta_url: tip.cta_url },
  );

  emitGuideTelemetry('guide.did_you_know.accepted', {
    user_id: identity.user_id,
    tip_key: tip.tip_key,
    feature_key: tip.feature_key,
    index_pillar_link: tip.index_pillar_link,
    channel,
    landed_at_cta_url: tip.cta_url,
    introduction_recorded: introRes.success,
  }).catch(() => {});

  return res.json({ ok: true, cta_url: tip.cta_url });
});

// =============================================================================
// POST /decline — user dismissed (tip | today | stop)
// =============================================================================

router.post('/decline', async (req: Request, res: Response) => {
  const identity = await resolveIdentity(req);
  if (!identity.user_id) {
    return res.status(401).json({ ok: false, error: identity.error || 'unauthorized' });
  }

  const tipKey = typeof req.body?.tip_key === 'string' ? req.body.tip_key : null;
  const rawScope = req.body?.scope;
  const scope: 'tip' | 'today' | 'stop' =
    rawScope === 'today' || rawScope === 'stop' ? rawScope : 'tip';
  const channel =
    req.body?.channel === 'voice' ? 'voice' : req.body?.channel === 'card' ? 'card' : 'card';

  if (!tipKey) {
    return res.status(400).json({ ok: false, error: 'tip_key_required' });
  }

  const tip = getTipByKey(tipKey);
  // tip_not_found is fine for decline — still mark the surface dismissed

  // Always dismiss the current surface touch
  await acknowledgeTouch({
    user_id: identity.user_id,
    surface: 'did_you_know_card',
    action: 'dismissed',
  }).catch(() => ({ success: false }));

  if (scope === 'today') {
    // Pause all proactive surfaces for the rest of the day + overnight.
    // Duration: until 06:00 tomorrow UTC (matches the existing "not today"
    // convention in the dismissal-tool contract).
    const now = new Date();
    const tomorrow6am = new Date(now);
    tomorrow6am.setUTCDate(tomorrow6am.getUTCDate() + 1);
    tomorrow6am.setUTCHours(6, 0, 0, 0);
    const durationMinutes = Math.max(
      60,
      Math.floor((tomorrow6am.getTime() - now.getTime()) / 60000),
    );
    await executePauseProactiveGuidance(
      {
        scope: 'all',
        duration_minutes: durationMinutes,
        reason: 'did_you_know:not_today',
      },
      { user_id: identity.user_id, channel: channel === 'voice' ? 'voice' : 'text' },
    ).catch(() => {});
  } else if (scope === 'stop') {
    // Stop the tour globally — long pause on the category 'did_you_know'.
    await executePauseProactiveGuidance(
      {
        scope: 'category',
        scope_value: 'did_you_know',
        duration_minutes: 60 * 24 * 90, // 90 days
        reason: 'did_you_know:stop_tour',
      },
      { user_id: identity.user_id, channel: channel === 'voice' ? 'voice' : 'text' },
    ).catch(() => {});
  }

  emitGuideTelemetry('guide.did_you_know.declined', {
    user_id: identity.user_id,
    tip_key: tipKey,
    feature_key: tip?.feature_key ?? null,
    index_pillar_link: tip?.index_pillar_link ?? null,
    scope,
    channel,
  }).catch(() => {});

  return res.json({ ok: true, scope });
});

export default router;
