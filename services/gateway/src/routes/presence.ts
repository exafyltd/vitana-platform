/**
 * Companion Phase H — Proactive Presence routes (VTID-01947)
 *
 * Mounted at /api/v1/presence. Surfaces awareness-driven content for
 * non-voice UI moments: Priority of the Day, Welcome-Back Banner,
 * Self-Awareness preview.
 *
 * Every endpoint here consults the pacer before returning content so
 * dismissal-pauses and per-user cadence caps apply uniformly.
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  getAwarenessContext,
  canSurfaceProactively,
  recordTouch,
} from '../services/guide';
import { resolvePriorityMessage } from '../services/guide/priority-rules';

const router = Router();

// =============================================================================
// Helpers
// =============================================================================

async function resolveIdentity(req: Request): Promise<{
  user_id: string | null;
  tenant_id: string | null;
  user_name: string | null;
  error?: string;
}> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return { user_id: null, tenant_id: null, user_name: null, error: 'no_token' };
  }
  const token = auth.slice(7);
  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');
    if (error || !data) {
      return { user_id: null, tenant_id: null, user_name: null, error: error?.message || 'no_context' };
    }
    return {
      user_id: data.user_id || data.id || null,
      tenant_id: data.tenant_id || null,
      user_name: data.display_name || null,
    };
  } catch (err: any) {
    return { user_id: null, tenant_id: null, user_name: null, error: err.message };
  }
}

// =============================================================================
// GET /priority — awareness-driven Priority of the Day
// =============================================================================

router.get('/priority', async (req: Request, res: Response) => {
  const identity = await resolveIdentity(req);
  if (!identity.user_id || !identity.tenant_id) {
    return res.status(401).json({ ok: false, error: identity.error || 'unauthorized' });
  }

  // Pacer check — respects user_proactive_pause, per-surface caps, dismissals.
  // bypass_daily_cap=true here because the priority card is ALWAYS visible
  // on Home; it's not a "proactive touch" that consumes a daily slot. But
  // we still respect active pauses (which suppress all proactivity).
  const decision = await canSurfaceProactively(identity.user_id, 'priority_card', {
    bypass_daily_cap: true,
  });
  if (!decision.allow && decision.reason === 'paused') {
    return res.json({
      ok: true,
      suppressed: true,
      reason: 'paused',
      pause: decision.pause,
    });
  }

  try {
    const awareness = await getAwarenessContext(identity.user_id, identity.tenant_id);
    const priority = resolvePriorityMessage({
      awareness,
      now: new Date(),
      user_name: identity.user_name,
    });

    // Fire-and-forget telemetry touch (doesn't count toward daily cap because
    // we bypassed it — but log for dashboard visibility).
    recordTouch({
      user_id: identity.user_id,
      surface: 'priority_card',
      reason_tag: priority.reason_tag,
      metadata: { variant: priority.variant },
    }).catch(() => {});

    return res.json({
      ok: true,
      suppressed: false,
      message: priority.message,
      cta_url: priority.cta_url,
      reason_tag: priority.reason_tag,
      variant: priority.variant,
    });
  } catch (err: any) {
    console.error('[presence/priority] error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// GET /welcome — Welcome-Back banner content (VTID-01948 Phase H.1)
// =============================================================================

router.get('/welcome', async (req: Request, res: Response) => {
  const identity = await resolveIdentity(req);
  if (!identity.user_id || !identity.tenant_id) {
    return res.status(401).json({ ok: false, error: identity.error || 'unauthorized' });
  }

  // Pacer check — welcome banner consumes 1 daily cap slot (unlike Priority
  // card which is always-on). If cap reached or pause active, suppress.
  const decision = await canSurfaceProactively(identity.user_id, 'welcome_banner');
  if (!decision.allow) {
    return res.json({
      ok: true,
      should_show: false,
      reason: decision.reason,
    });
  }

  try {
    const awareness = await getAwarenessContext(identity.user_id, identity.tenant_id);

    // Render rule: only show for returning users with a meaningful absence
    // (>= same_day). Reconnect/recent = no banner. First-session = no banner
    // (handled by voice intro, not home banner).
    const bucket = awareness.last_interaction?.bucket;
    const eligibleBuckets = ['today', 'yesterday', 'week', 'long'];
    if (!bucket || !eligibleBuckets.includes(bucket)) {
      return res.json({ ok: true, should_show: false, reason: 'bucket_ineligible' });
    }

    const firstName = (identity.user_name || '').split(' ')[0] || '';
    const motiv = awareness.last_interaction?.motivation_signal;
    const days = awareness.last_interaction?.days_since_last ?? 0;
    const openRecs = awareness.recent_activity?.open_autopilot_recs ?? 0;
    const overdue = awareness.recent_activity?.overdue_calendar_count ?? 0;
    const streak = awareness.community_signals?.diary_streak_days ?? 0;

    // Build copy — variant depends on motivation
    let copy: string;
    let variant: 'urgent' | 'warm' | 'engage' | 'inform';
    let cta_url: string | null = '/autopilot';
    let reason_tag: string;

    if (motiv === 'absent') {
      copy = `Hi ${firstName}${firstName ? ', ' : ''}haven't seen you in ${days} days. I'm glad you're back. Where have you been?`;
      variant = 'warm';
      cta_url = null; // invites conversation, not a click
      reason_tag = `absent:${days}d`;
    } else if (motiv === 'cooling') {
      const parts: string[] = [];
      if (openRecs > 0) parts.push(`${openRecs} Autopilot action${openRecs === 1 ? '' : 's'} waiting`);
      if (overdue > 0) parts.push(`${overdue} overdue item${overdue === 1 ? '' : 's'}`);
      const tail = parts.length ? ` — ${parts.join(', ')}` : '';
      copy = `Welcome back, ${firstName || 'friend'}. It's been ${days} days${tail}.`;
      variant = 'warm';
      reason_tag = `cooling:${days}d`;
    } else if (bucket === 'week') {
      copy = `Good to hear from you again${firstName ? ', ' + firstName : ''} — it's been a few days.`;
      variant = 'warm';
      reason_tag = `week:${days}d`;
    } else if (streak > 0 && bucket === 'yesterday') {
      copy = `Welcome back${firstName ? ', ' + firstName : ''}. Your ${streak}-day diary streak is waiting.`;
      cta_url = '/memory?tab=diary';
      variant = 'engage';
      reason_tag = `yesterday:streak${streak}`;
    } else {
      // today / yesterday without streak — light touch
      copy = `Welcome back${firstName ? ', ' + firstName : ''}.`;
      variant = 'inform';
      reason_tag = `${bucket}:light`;
    }

    // Record the touch BEFORE returning so the daily cap counts it
    recordTouch({
      user_id: identity.user_id,
      surface: 'welcome_banner',
      reason_tag,
      metadata: { variant, bucket, days_since_last: days },
    }).catch(() => {});

    return res.json({
      ok: true,
      should_show: true,
      copy,
      cta_url,
      variant,
      reason_tag,
      bucket,
      days_since_last: days,
    });
  } catch (err: any) {
    console.error('[presence/welcome] error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'INTERNAL_ERROR' });
  }
});

router.post('/welcome/ack', async (req: Request, res: Response) => {
  const identity = await resolveIdentity(req);
  if (!identity.user_id) {
    return res.status(401).json({ ok: false, error: identity.error || 'unauthorized' });
  }
  const action = (req.body?.action === 'dismissed' ? 'dismissed' : 'acknowledged') as
    | 'acknowledged'
    | 'dismissed';
  const { acknowledgeTouch } = await import('../services/guide');
  await acknowledgeTouch({
    user_id: identity.user_id,
    surface: 'welcome_banner',
    action,
  });
  return res.json({ ok: true });
});

// =============================================================================
// POST /priority/ack — user tapped the CTA (or dismissed)
// =============================================================================

router.post('/priority/ack', async (req: Request, res: Response) => {
  const identity = await resolveIdentity(req);
  if (!identity.user_id) {
    return res.status(401).json({ ok: false, error: identity.error || 'unauthorized' });
  }
  const action = (req.body?.action === 'dismissed' ? 'dismissed' : 'acknowledged') as
    | 'acknowledged'
    | 'dismissed';
  const { acknowledgeTouch } = await import('../services/guide');
  await acknowledgeTouch({
    user_id: identity.user_id,
    surface: 'priority_card',
    action,
  });
  return res.json({ ok: true });
});

export default router;
