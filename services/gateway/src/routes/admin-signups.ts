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
import { requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { notifyUserAsync } from '../services/notification-service';
import { dispatchEvent } from '../services/automation-executor';
import * as repo from '../services/admin-signups/admin-signups-repository';

const router = Router();
const VTID = 'ADMIN-SIGNUPS';

// ── GET / — Funnel dashboard ────────────────────────────────

router.get('/', requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { stage, tenant_id, search, limit: limitStr, offset: offsetStr } = req.query;
  const limit = Math.min(parseInt(limitStr as string) || 50, 200);
  const offset = parseInt(offsetStr as string) || 0;

  try {
    const { data, error } = await repo.fetchSignupFunnel(supabase, {
      stage: stage && typeof stage === 'string' ? stage : undefined,
      tenantId: tenant_id && typeof tenant_id === 'string' ? tenant_id : undefined,
      search: search && typeof search === 'string' ? search : undefined,
      offset,
      limit,
    });
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

router.get('/stats', requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { tenant_id, days } = req.query;
  const dayWindow = parseInt(days as string) || 30;

  try {
    const since = new Date(Date.now() - dayWindow * 86400000).toISOString();

    // Get all attempts within window
    const { data: attempts, error } = await repo.fetchAttemptsStatsWindow(
      supabase,
      since,
      tenant_id && typeof tenant_id === 'string' ? tenant_id : undefined,
    );
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
    const { count: totalUsers } = await repo.countRegisteredUsers(
      supabase,
      tenant_id && typeof tenant_id === 'string' ? tenant_id : undefined,
    );

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

router.get('/attempts', requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { limit: limitStr, offset: offsetStr, status, search } = req.query;
  const limit = Math.min(parseInt(limitStr as string) || 50, 200);
  const offset = parseInt(offsetStr as string) || 0;

  try {
    const { data, error, count } = await repo.fetchAttempts(supabase, {
      status: status && typeof status === 'string' ? status : undefined,
      search: search && typeof search === 'string' ? search : undefined,
      offset,
      limit,
    });
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

// public-route
router.post('/log-attempt', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { email, tenant_id, metadata } = req.body;
  if (!email || !tenant_id) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'email and tenant_id are required' });
  }

  try {
    const { data, error } = await repo.insertSignupAttempt(supabase, {
      email: email.trim().toLowerCase(),
      tenant_id,
      status: 'started',
      metadata: metadata || {},
      ip_address: req.ip || null,
      user_agent: req.headers['user-agent'] || null,
    });

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

// public-route
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

    const { error } = await repo.updateSignupAttempt(supabase, attempt_id, updateData);

    if (error) {
      console.error(`[${VTID}] POST /log-result error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    // Dispatch automation event when user completes onboarding
    if (status === 'onboarded' && auth_user_id) {
      const tenantId = process.env.DEFAULT_TENANT_ID;
      if (tenantId) {
        // Look up referral/shared_link source from signup_attempts
        const { data: attempt } = await repo.fetchAttemptReferralInfo(supabase, attempt_id);

        dispatchEvent(tenantId, 'user.signup.completed', {
          user_id: auth_user_id,
          attempt_id,
        }).catch(err => console.warn(`[${VTID}] dispatch user.signup.completed failed:`, err.message));

        // Dispatch referral event if applicable
        if (attempt?.referral_code) {
          dispatchEvent(tenantId, 'user.signup.referral', {
            user_id: auth_user_id,
            referral_code: attempt.referral_code,
          }).catch(err => console.warn(`[${VTID}] dispatch user.signup.referral failed:`, err.message));
        }

        // Dispatch shared_link event if applicable
        if (attempt?.utm_source === 'sharing_link' || attempt?.utm_campaign?.startsWith('share_')) {
          dispatchEvent(tenantId, 'user.signup.shared_link', {
            user_id: auth_user_id,
            utm_campaign: attempt.utm_campaign,
          }).catch(err => console.warn(`[${VTID}] dispatch user.signup.shared_link failed:`, err.message));
        }
      }
    }

    return res.json({ ok: true });
  } catch (err: any) {
    console.error(`[${VTID}] POST /log-result exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /:id/invite — Send onboarding invitation ──────────

router.post('/:id/invite', requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { id } = req.params;
  const { message, type } = req.body;

  try {
    // Get the signup attempt
    const { data: attempt, error: fetchError } = await repo.fetchAttemptById(supabase, id);

    if (fetchError || !attempt) {
      return res.status(404).json({ ok: false, error: 'ATTEMPT_NOT_FOUND' });
    }

    // Create invitation record
    const { data: invitation, error: insertError } = await repo.insertOnboardingInvitation(supabase, {
      tenant_id: attempt.tenant_id,
      signup_attempt_id: id,
      target_user_id: attempt.auth_user_id || null,
      email: attempt.email,
      invited_by: req.identity!.user_id,
      type: type || 'email',
      status: 'sent',
      message: message || 'We noticed you started signing up for Vitana. Would you like help completing your registration?',
    });

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

    console.log(`[${VTID}] Invitation sent to ${attempt.email} by ${req.identity!.email || 'unknown'}`);

    return res.json({ ok: true, invitation_id: invitation?.id });
  } catch (err: any) {
    console.error(`[${VTID}] POST /:id/invite exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /:id/repair — Re-run provisioning for stuck users ──

router.post('/:id/repair', requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { id } = req.params;

  try {
    // Get the signup attempt
    const { data: attempt, error: fetchError } = await repo.fetchAttemptById(supabase, id);

    if (fetchError || !attempt) {
      return res.status(404).json({ ok: false, error: 'ATTEMPT_NOT_FOUND' });
    }

    if (!attempt.auth_user_id) {
      return res.status(400).json({ ok: false, error: 'NO_AUTH_USER', message: 'User has not completed email verification' });
    }

    // Check if app_users row exists
    const { data: existingUser } = await repo.fetchAppUserByUserId(supabase, attempt.auth_user_id);

    if (existingUser) {
      // Check user_tenants
      const { data: existingMembership } = await repo.fetchUserTenantMembership(supabase, attempt.auth_user_id, attempt.tenant_id);

      if (existingMembership) {
        // Update signup attempt to onboarded
        await repo.updateSignupAttempt(supabase, id, { status: 'onboarded', completed_at: new Date().toISOString() });

        return res.json({ ok: true, message: 'User already fully provisioned', repaired: false });
      }

      // Create missing tenant membership
      await repo.insertUserTenant(supabase, {
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
      await repo.insertAppUser(supabase, {
        user_id: attempt.auth_user_id,
        email,
        tenant_id: attempt.tenant_id,
      });

      // Create user_tenants row
      await repo.insertUserTenant(supabase, {
        tenant_id: attempt.tenant_id,
        user_id: attempt.auth_user_id,
        active_role: 'community',
        is_primary: true,
      });
    }

    // Update signup attempt status
    await repo.updateSignupAttempt(supabase, id, { status: 'onboarded', completed_at: new Date().toISOString() });

    console.log(`[${VTID}] Repaired provisioning for ${attempt.email} by ${req.identity!.email || 'unknown'}`);

    return res.json({ ok: true, message: 'User provisioning repaired', repaired: true });
  } catch (err: any) {
    console.error(`[${VTID}] POST /:id/repair exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /invitations — List sent invitations ────────────────

router.get('/invitations', requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { limit: limitStr, offset: offsetStr, status } = req.query;
  const limit = Math.min(parseInt(limitStr as string) || 50, 200);
  const offset = parseInt(offsetStr as string) || 0;

  try {
    const { data, error, count } = await repo.fetchInvitations(supabase, {
      status: status && typeof status === 'string' ? status : undefined,
      offset,
      limit,
    });
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