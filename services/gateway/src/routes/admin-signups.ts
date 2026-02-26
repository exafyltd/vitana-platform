/**
 * Admin Signups API — Signup Funnel Tracking & Outreach
 *
 * Endpoints:
 * - GET  /                — Funnel dashboard with stage/tenant/search/date filters
 * - GET  /stats           — Aggregate funnel statistics (counts per stage)
 * - GET  /attempts        — Raw signup attempt log (paginated)
 * - POST /log-attempt     — Public endpoint for frontend to log registration attempt
 * - POST /log-result      — Public endpoint for frontend to log signup success/failure
 * - POST /:id/invite      — Send onboarding invitation to stuck user
 * - POST /:id/repair      — Re-run provisioning for stuck users
 * - GET  /invitations     — List sent invitations
 *
 * Security:
 * - GET/POST admin endpoints require Bearer token + exafy_admin
 * - POST /log-attempt and /log-result are public (called from signup forms)
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { notifyUserAsync } from '../services/notification-service';

const router = Router();
const VTID = 'ADMIN-SIGNUPS';

// ── Auth Helper ─────────────────────────────────────────────

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

// ── GET / — Funnel dashboard ────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) return res.status(authResult.status).json({ ok: false, error: authResult.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { stage, tenant_id, search, limit: limitStr, offset: offsetStr } = req.query;
  const limit = Math.min(parseInt(limitStr as string) || 50, 200);
  const offset = parseInt(offsetStr as string) || 0;

  try {
    let query = supabase
      .from('signup_funnel')
      .select('*')
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (stage && typeof stage === 'string') {
      query = query.eq('funnel_stage', stage);
    }
    if (tenant_id && typeof tenant_id === 'string') {
      query = query.eq('tenant_id', tenant_id);
    }
    if (search && typeof search === 'string') {
      query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) {
      console.error(`[${VTID}] GET / error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, data: data || [], count: data?.length || 0 });
  } catch (err: any) {
    console.error(`[${VTID}] GET / exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /stats — Aggregate funnel statistics ────────────────

router.get('/stats', async (req: Request, res: Response) => {
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) return res.status(authResult.status).json({ ok: false, error: authResult.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { tenant_id, days } = req.query;
  const dayWindow = parseInt(days as string) || 30;

  try {
    const since = new Date(Date.now() - dayWindow * 86400000).toISOString();

    // Get all attempts within window
    let query = supabase
      .from('signup_attempts')
      .select('status, tenant_id')
      .gte('started_at', since);

    if (tenant_id && typeof tenant_id === 'string') {
      query = query.eq('tenant_id', tenant_id);
    }

    const { data: attempts, error } = await query;
    if (error) {
      console.error(`[${VTID}] GET /stats error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const stats = {
      total: attempts?.length || 0,
      started: attempts?.filter(a => a.status === 'started').length || 0,
      email_sent: attempts?.filter(a => a.status === 'email_sent').length || 0,
      verified: attempts?.filter(a => a.status === 'verified').length || 0,
      profile_created: attempts?.filter(a => a.status === 'profile_created').length || 0,
      onboarded: attempts?.filter(a => a.status === 'onboarded').length || 0,
      abandoned: attempts?.filter(a => a.status === 'abandoned').length || 0,
      days: dayWindow,
    };

    // Also get total registered users from app_users
    let usersQuery = supabase.from('app_users').select('user_id', { count: 'exact', head: true });
    if (tenant_id && typeof tenant_id === 'string') {
      usersQuery = usersQuery.eq('tenant_id', tenant_id);
    }
    const { count: totalUsers } = await usersQuery;

    return res.json({
      ok: true,
      stats,
      total_registered_users: totalUsers || 0,
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /stats exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /attempts — Raw signup attempt log ──────────────────

router.get('/attempts', async (req: Request, res: Response) => {
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) return res.status(authResult.status).json({ ok: false, error: authResult.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { limit: limitStr, offset: offsetStr, status, search } = req.query;
  const limit = Math.min(parseInt(limitStr as string) || 50, 200);
  const offset = parseInt(offsetStr as string) || 0;

  try {
    let query = supabase
      .from('signup_attempts')
      .select('*', { count: 'exact' })
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && typeof status === 'string') {
      query = query.eq('status', status);
    }
    if (search && typeof search === 'string') {
      query = query.ilike('email', `%${search}%`);
    }

    const { data, error, count } = await query;
    if (error) {
      console.error(`[${VTID}] GET /attempts error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, data: data || [], total: count || 0, limit, offset });
  } catch (err: any) {
    console.error(`[${VTID}] GET /attempts exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /log-attempt — Public: log registration attempt ────

router.post('/log-attempt', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { email, tenant_id, metadata } = req.body;
  if (!email || !tenant_id) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'email and tenant_id are required' });
  }

  try {
    const { data, error } = await supabase
      .from('signup_attempts')
      .insert({
        email: email.trim().toLowerCase(),
        tenant_id,
        status: 'started',
        metadata: metadata || {},
        ip_address: req.ip || null,
        user_agent: req.headers['user-agent'] || null,
      })
      .select('id')
      .single();

    if (error) {
      console.error(`[${VTID}] POST /log-attempt error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, attempt_id: data?.id });
  } catch (err: any) {
    console.error(`[${VTID}] POST /log-attempt exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /log-result — Public: log signup success/failure ───

router.post('/log-result', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { attempt_id, status, auth_user_id } = req.body;
  if (!attempt_id || !status) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'attempt_id and status are required' });
  }

  const validStatuses = ['started', 'email_sent', 'verified', 'profile_created', 'onboarded', 'abandoned'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ ok: false, error: 'INVALID_STATUS', valid: validStatuses });
  }

  try {
    const updateData: Record<string, any> = { status };
    if (auth_user_id) updateData.auth_user_id = auth_user_id;
    if (status === 'onboarded' || status === 'abandoned') updateData.completed_at = new Date().toISOString();

    const { error } = await supabase
      .from('signup_attempts')
      .update(updateData)
      .eq('id', attempt_id);

    if (error) {
      console.error(`[${VTID}] POST /log-result error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true });
  } catch (err: any) {
    console.error(`[${VTID}] POST /log-result exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /:id/invite — Send onboarding invitation ──────────

router.post('/:id/invite', async (req: Request, res: Response) => {
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) return res.status(authResult.status).json({ ok: false, error: authResult.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { id } = req.params;
  const { message, type } = req.body;

  try {
    // Get the signup attempt
    const { data: attempt, error: fetchError } = await supabase
      .from('signup_attempts')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !attempt) {
      return res.status(404).json({ ok: false, error: 'ATTEMPT_NOT_FOUND' });
    }

    // Create invitation record
    const { data: invitation, error: insertError } = await supabase
      .from('onboarding_invitations')
      .insert({
        tenant_id: attempt.tenant_id,
        signup_attempt_id: id,
        target_user_id: attempt.auth_user_id || null,
        email: attempt.email,
        invited_by: authResult.user_id,
        type: type || 'email',
        status: 'sent',
        message: message || 'We noticed you started signing up for Vitana. Would you like help completing your registration?',
      })
      .select('id')
      .single();

    if (insertError) {
      console.error(`[${VTID}] POST /:id/invite insert error:`, insertError.message);
      return res.status(500).json({ ok: false, error: insertError.message });
    }

    // If user exists in auth, send in-app notification
    if (attempt.auth_user_id) {
      notifyUserAsync(
        attempt.auth_user_id,
        attempt.tenant_id,
        'welcome_to_vitana',
        {
          title: 'Complete Your Vitana Setup',
          body: message || 'We noticed you started signing up. Tap here to finish setting up your profile!',
          data: { url: '/settings', type: 'onboarding_invite' },
        },
        supabase
      );
    }

    console.log(`[${VTID}] Invitation sent to ${attempt.email} by ${authResult.email}`);

    return res.json({ ok: true, invitation_id: invitation?.id });
  } catch (err: any) {
    console.error(`[${VTID}] POST /:id/invite exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /:id/repair — Re-run provisioning for stuck users ──

router.post('/:id/repair', async (req: Request, res: Response) => {
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) return res.status(authResult.status).json({ ok: false, error: authResult.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { id } = req.params;

  try {
    // Get the signup attempt
    const { data: attempt, error: fetchError } = await supabase
      .from('signup_attempts')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !attempt) {
      return res.status(404).json({ ok: false, error: 'ATTEMPT_NOT_FOUND' });
    }

    if (!attempt.auth_user_id) {
      return res.status(400).json({ ok: false, error: 'NO_AUTH_USER', message: 'User has not completed email verification' });
    }

    // Check if app_users row exists
    const { data: existingUser } = await supabase
      .from('app_users')
      .select('user_id')
      .eq('user_id', attempt.auth_user_id)
      .single();

    if (existingUser) {
      // Check user_tenants
      const { data: existingMembership } = await supabase
        .from('user_tenants')
        .select('tenant_id')
        .eq('user_id', attempt.auth_user_id)
        .eq('tenant_id', attempt.tenant_id)
        .single();

      if (existingMembership) {
        // Update signup attempt to onboarded
        await supabase
          .from('signup_attempts')
          .update({ status: 'onboarded', completed_at: new Date().toISOString() })
          .eq('id', id);

        return res.json({ ok: true, message: 'User already fully provisioned', repaired: false });
      }

      // Create missing tenant membership
      await supabase.from('user_tenants').insert({
        tenant_id: attempt.tenant_id,
        user_id: attempt.auth_user_id,
        active_role: 'community',
        is_primary: true,
      });
    } else {
      // Get email from auth
      const { data: authUser } = await supabase.auth.admin.getUserById(attempt.auth_user_id);
      const email = authUser?.user?.email || attempt.email;

      // Create app_users row
      await supabase.from('app_users').insert({
        user_id: attempt.auth_user_id,
        email,
        tenant_id: attempt.tenant_id,
      });

      // Create user_tenants row
      await supabase.from('user_tenants').insert({
        tenant_id: attempt.tenant_id,
        user_id: attempt.auth_user_id,
        active_role: 'community',
        is_primary: true,
      });
    }

    // Update signup attempt status
    await supabase
      .from('signup_attempts')
      .update({ status: 'onboarded', completed_at: new Date().toISOString() })
      .eq('id', id);

    console.log(`[${VTID}] Repaired provisioning for ${attempt.email} by ${authResult.email}`);

    return res.json({ ok: true, message: 'User provisioning repaired', repaired: true });
  } catch (err: any) {
    console.error(`[${VTID}] POST /:id/repair exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /invitations — List sent invitations ────────────────

router.get('/invitations', async (req: Request, res: Response) => {
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) return res.status(authResult.status).json({ ok: false, error: authResult.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { limit: limitStr, offset: offsetStr, status } = req.query;
  const limit = Math.min(parseInt(limitStr as string) || 50, 200);
  const offset = parseInt(offsetStr as string) || 0;

  try {
    let query = supabase
      .from('onboarding_invitations')
      .select('*', { count: 'exact' })
      .order('sent_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && typeof status === 'string') {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;
    if (error) {
      console.error(`[${VTID}] GET /invitations error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, data: data || [], total: count || 0, limit, offset });
  } catch (err: any) {
    console.error(`[${VTID}] GET /invitations exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
