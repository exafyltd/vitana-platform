/**
 * Admin Signups API — Signup Funnel Tracker & Abandoned Registration Recovery
 *
 * Provides the XFI developer team with full visibility into the signup pipeline:
 * - Who tried to register and where they got stuck
 * - Who has confirmed email but never logged in
 * - Who logged in but is missing platform records (provisioning failures)
 * - Tools to invite users back via live rooms, meetups, or notifications
 *
 * Endpoints:
 * - GET    /api/v1/admin/signups               - Signup funnel dashboard (all users)
 * - GET    /api/v1/admin/signups/stats          - Aggregate funnel statistics
 * - GET    /api/v1/admin/signups/attempts       - Raw signup attempts log
 * - POST   /api/v1/admin/signups/log-attempt    - Log a signup attempt (public, no auth)
 * - POST   /api/v1/admin/signups/log-result     - Log signup result (public, no auth)
 * - POST   /api/v1/admin/signups/:id/invite     - Send onboarding invitation
 * - POST   /api/v1/admin/signups/:id/create-onboarding-room - Create a live room for 1:1 onboarding
 * - GET    /api/v1/admin/signups/invitations    - List all onboarding invitations
 * - POST   /api/v1/admin/signups/:id/repair     - Re-run provisioning for a stuck user
 * - GET    /api/v1/admin/signups/health         - Health check
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';

const router = Router();

// =============================================================================
// Helpers
// =============================================================================

function getSupabaseServiceClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;
  return { url: supabaseUrl, key: serviceKey };
}

async function supabaseQuery(path: string, options: {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
} = {}) {
  const config = getSupabaseServiceClient();
  if (!config) throw new Error('Supabase not configured');

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'apikey': config.key,
      'Authorization': `Bearer ${config.key}`,
      'Prefer': options.method === 'POST' ? 'return=representation' : 'return=representation',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase error ${response.status}: ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// Rate limiter for public endpoints (log-attempt, log-result)
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { ok: false, error: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false,
});

// =============================================================================
// Validation schemas
// =============================================================================

const LogAttemptSchema = z.object({
  email: z.string().email().max(255),
  tenant_slug: z.string().max(50).optional(),
  display_name: z.string().max(255).optional(),
  source: z.enum(['web', 'mobile', 'api']).optional().default('web'),
  metadata: z.record(z.any()).optional(),
});

const LogResultSchema = z.object({
  email: z.string().email().max(255),
  success: z.boolean(),
  failure_reason: z.string().max(500).optional(),
  auth_user_id: z.string().uuid().optional(),
});

const InviteSchema = z.object({
  invitation_type: z.enum(['email', 'live_room', 'meetup', 'push_notification']),
  message: z.string().max(2000).optional(),
  live_room_id: z.string().uuid().optional(),
  meetup_id: z.string().uuid().optional(),
});

// =============================================================================
// PUBLIC ENDPOINTS (no auth required — called by frontend during signup)
// =============================================================================

/**
 * POST /log-attempt
 * Called by the frontend BEFORE calling supabase.auth.signUp().
 * This captures the attempt even if Supabase signup fails.
 */
router.post('/log-attempt', publicLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = LogAttemptSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_INPUT',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { email, tenant_slug, display_name, source, metadata } = parsed.data;

    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
      || req.socket.remoteAddress
      || null;
    const userAgent = req.headers['user-agent'] || null;

    const row = {
      id: randomUUID(),
      email: email.toLowerCase().trim(),
      tenant_slug: tenant_slug || null,
      display_name: display_name || null,
      source,
      status: 'attempted',
      ip_address: ip,
      user_agent: userAgent,
      metadata: metadata || {},
      attempted_at: new Date().toISOString(),
    };

    await supabaseQuery('signup_attempts', {
      method: 'POST',
      body: row,
      headers: {
        // Use anon key for this insert since it's a public endpoint
        'apikey': process.env.SUPABASE_ANON_KEY || getSupabaseServiceClient()!.key,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY || getSupabaseServiceClient()!.key}`,
      },
    });

    console.log(`[Signup Tracker] Attempt logged: ${email} (${tenant_slug || 'default'})`);

    return res.status(201).json({
      ok: true,
      attempt_id: row.id,
    });
  } catch (err: any) {
    console.error('[Signup Tracker] log-attempt error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /log-result
 * Called by the frontend AFTER supabase.auth.signUp() returns (success or failure).
 */
router.post('/log-result', publicLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = LogResultSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_INPUT',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { email, success, failure_reason, auth_user_id } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const config = getSupabaseServiceClient();
    if (!config) {
      return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
    }

    if (success) {
      // Update the most recent attempt for this email
      await fetch(`${config.url}/rest/v1/signup_attempts?email=eq.${encodeURIComponent(normalizedEmail)}&status=eq.attempted&order=attempted_at.desc&limit=1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.key,
          'Authorization': `Bearer ${config.key}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          status: 'succeeded',
          auth_user_id: auth_user_id || null,
          succeeded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      console.log(`[Signup Tracker] Success logged: ${normalizedEmail}`);
    } else {
      // Update the most recent attempt with failure
      await fetch(`${config.url}/rest/v1/signup_attempts?email=eq.${encodeURIComponent(normalizedEmail)}&status=eq.attempted&order=attempted_at.desc&limit=1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.key,
          'Authorization': `Bearer ${config.key}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          status: 'failed',
          failure_reason: failure_reason || 'unknown',
          updated_at: new Date().toISOString(),
        }),
      });
      console.log(`[Signup Tracker] Failure logged: ${normalizedEmail} - ${failure_reason}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('[Signup Tracker] log-result error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// AUTHENTICATED ENDPOINTS (for XFI team / admin users)
// =============================================================================

/**
 * GET / (root)
 * Returns the full signup funnel view — the single pane of glass for the XFI team.
 * Shows every registered user with their onboarding stage.
 *
 * Query params:
 *   ?stage=email_pending,provisioning_failed  (comma-separated filter)
 *   ?tenant=maxina                            (tenant slug filter)
 *   ?since=2026-01-01                         (registration date filter)
 *   ?limit=50&offset=0                        (pagination)
 *   ?search=john@example.com                  (email search)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const config = getSupabaseServiceClient();
    if (!config) {
      return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
    }

    const stage = (req.query.stage as string) || '';
    const tenant = (req.query.tenant as string) || '';
    const since = (req.query.since as string) || '';
    const search = (req.query.search as string) || '';
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // Build query against the signup_funnel view
    let queryPath = `signup_funnel?order=registered_at.desc&limit=${limit}&offset=${offset}`;

    if (stage) {
      const stages = stage.split(',').map(s => s.trim());
      queryPath += `&onboarding_stage=in.(${stages.join(',')})`;
    }

    if (tenant) {
      queryPath += `&resolved_tenant_slug=eq.${encodeURIComponent(tenant)}`;
    }

    if (since) {
      queryPath += `&registered_at=gte.${encodeURIComponent(since)}`;
    }

    if (search) {
      queryPath += `&email=ilike.*${encodeURIComponent(search)}*`;
    }

    const data = await supabaseQuery(queryPath);

    console.log(`[Signup Tracker] Funnel query: ${data?.length || 0} results`);

    return res.status(200).json({
      ok: true,
      users: data || [],
      count: data?.length || 0,
      filters: { stage, tenant, since, search, limit, offset },
    });
  } catch (err: any) {
    console.error('[Signup Tracker] funnel query error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /stats
 * Returns aggregate statistics about the signup funnel.
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const config = getSupabaseServiceClient();
    if (!config) {
      return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
    }

    // Get all funnel data (limited to recent users for performance)
    const since = (req.query.since as string) || new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    const data = await supabaseQuery(
      `signup_funnel?registered_at=gte.${encodeURIComponent(since)}&select=onboarding_stage,email_confirmed,has_app_user,has_tenant_membership,has_live_room,has_logged_in,welcome_notification_sent,resolved_tenant_slug`
    );

    const users = data || [];

    // Compute stage counts
    const stageCounts: Record<string, number> = {};
    const tenantCounts: Record<string, number> = {};

    for (const u of users) {
      const stage = u.onboarding_stage || 'unknown';
      stageCounts[stage] = (stageCounts[stage] || 0) + 1;

      const tenant = u.resolved_tenant_slug || 'unassigned';
      tenantCounts[tenant] = (tenantCounts[tenant] || 0) + 1;
    }

    // Funnel percentages
    const total = users.length;
    const emailConfirmed = users.filter((u: any) => u.email_confirmed).length;
    const provisioned = users.filter((u: any) => u.has_app_user).length;
    const hasTenant = users.filter((u: any) => u.has_tenant_membership).length;
    const hasLiveRoom = users.filter((u: any) => u.has_live_room).length;
    const hasLoggedIn = users.filter((u: any) => u.has_logged_in).length;
    const welcomeSent = users.filter((u: any) => u.welcome_notification_sent).length;

    // Signup attempts stats
    let attemptStats: any = {};
    try {
      const attempts = await supabaseQuery(
        `signup_attempts?attempted_at=gte.${encodeURIComponent(since)}&select=status`
      );
      const attemptList = attempts || [];
      attemptStats = {
        total_attempts: attemptList.length,
        succeeded: attemptList.filter((a: any) => a.status === 'succeeded').length,
        failed: attemptList.filter((a: any) => a.status === 'failed').length,
        pending: attemptList.filter((a: any) => a.status === 'attempted').length,
        confirmed: attemptList.filter((a: any) => a.status === 'confirmed').length,
      };
    } catch (e) {
      // signup_attempts table might not exist yet
      attemptStats = { note: 'signup_attempts table not yet available' };
    }

    return res.status(200).json({
      ok: true,
      period: { since },
      total_registered_users: total,
      funnel: {
        registered: total,
        email_confirmed: emailConfirmed,
        provisioned,
        has_tenant: hasTenant,
        has_live_room: hasLiveRoom,
        has_logged_in: hasLoggedIn,
        welcome_sent: welcomeSent,
      },
      funnel_percentages: {
        email_confirmed: total ? Math.round((emailConfirmed / total) * 100) : 0,
        provisioned: total ? Math.round((provisioned / total) * 100) : 0,
        has_tenant: total ? Math.round((hasTenant / total) * 100) : 0,
        has_live_room: total ? Math.round((hasLiveRoom / total) * 100) : 0,
        has_logged_in: total ? Math.round((hasLoggedIn / total) * 100) : 0,
        welcome_sent: total ? Math.round((welcomeSent / total) * 100) : 0,
      },
      stages: stageCounts,
      tenants: tenantCounts,
      signup_attempts: attemptStats,
      needs_attention: {
        email_pending: stageCounts['email_pending'] || 0,
        provisioning_failed: stageCounts['provisioning_failed'] || 0,
        no_tenant: stageCounts['no_tenant'] || 0,
        never_logged_in: stageCounts['never_logged_in'] || 0,
      },
    });
  } catch (err: any) {
    console.error('[Signup Tracker] stats error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /attempts
 * Returns raw signup attempts (including failed ones that never reached auth.users).
 */
router.get('/attempts', async (req: Request, res: Response) => {
  try {
    const config = getSupabaseServiceClient();
    if (!config) {
      return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
    }

    const status = (req.query.status as string) || '';
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    let queryPath = `signup_attempts?order=attempted_at.desc&limit=${limit}&offset=${offset}`;

    if (status) {
      const statuses = status.split(',').map(s => s.trim());
      queryPath += `&status=in.(${statuses.join(',')})`;
    }

    const data = await supabaseQuery(queryPath);

    return res.status(200).json({
      ok: true,
      attempts: data || [],
      count: data?.length || 0,
    });
  } catch (err: any) {
    console.error('[Signup Tracker] attempts query error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /:authUserId/invite
 * Send an onboarding invitation to a user who got stuck.
 * Creates an onboarding_invitations record and optionally triggers a notification.
 */
router.post('/:authUserId/invite', async (req: Request, res: Response) => {
  try {
    const { authUserId } = req.params;
    const parsed = InviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_INPUT',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const config = getSupabaseServiceClient();
    if (!config) {
      return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
    }

    const { invitation_type, message, live_room_id, meetup_id } = parsed.data;

    // Fetch user from signup_funnel
    const funnelData = await supabaseQuery(
      `signup_funnel?auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
    );

    if (!funnelData || funnelData.length === 0) {
      return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
    }

    const user = funnelData[0];

    // Create invitation record
    const invitation = {
      id: randomUUID(),
      email: user.email,
      auth_user_id: authUserId,
      tenant_id: user.tenant_slug ? undefined : undefined, // will be resolved
      invitation_type,
      status: 'pending',
      message: message || `Hi ${user.display_name || 'there'}! We noticed you started signing up for Vitana. We'd love to help you get set up. Join us for a personal onboarding session!`,
      live_room_id: live_room_id || null,
      meetup_id: meetup_id || null,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), // 7 days
    };

    const result = await supabaseQuery('onboarding_invitations', {
      method: 'POST',
      body: invitation,
    });

    console.log(`[Signup Tracker] Invitation created: ${invitation_type} for ${user.email}`);

    // If the user has an FCM token and invitation_type includes push, send notification
    if (invitation_type === 'push_notification' || invitation_type === 'live_room') {
      try {
        const { notifyUserAsync } = require('../services/notification-service');
        const { getSupabase } = require('../lib/supabase');
        const supabase = getSupabase();

        if (supabase && user.has_app_user) {
          // Look up tenant_id
          const { data: tenantRow } = await supabase
            .from('user_tenants')
            .select('tenant_id')
            .eq('user_id', authUserId)
            .eq('is_primary', true)
            .single();

          if (tenantRow?.tenant_id) {
            notifyUserAsync(authUserId, tenantRow.tenant_id, 'live_room_invite', {
              title: 'Personal Onboarding Session',
              body: invitation.message,
              data: live_room_id ? { url: `/live/${live_room_id}` } : { url: '/dashboard' },
            }, supabase);
          }
        }
      } catch (notifErr: any) {
        console.warn(`[Signup Tracker] Notification send failed (non-fatal): ${notifErr.message}`);
      }
    }

    return res.status(201).json({
      ok: true,
      invitation: result?.[0] || invitation,
    });
  } catch (err: any) {
    console.error('[Signup Tracker] invite error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /:authUserId/create-onboarding-room
 * Creates a dedicated live room for 1:1 onboarding with a stuck user.
 * The XFI team member can then join and walk the user through Vitana.
 */
router.post('/:authUserId/create-onboarding-room', async (req: Request, res: Response) => {
  try {
    const { authUserId } = req.params;
    const config = getSupabaseServiceClient();
    if (!config) {
      return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
    }

    // Get user info
    const funnelData = await supabaseQuery(
      `signup_funnel?auth_user_id=eq.${encodeURIComponent(authUserId)}&limit=1`
    );

    if (!funnelData || funnelData.length === 0) {
      return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
    }

    const user = funnelData[0];
    const displayName = user.display_name || user.email.split('@')[0];

    // Resolve tenant_id (use user's tenant or fall back to first available)
    let tenantId: string | null = null;
    try {
      if (user.resolved_tenant_slug) {
        const tenantData = await supabaseQuery(
          `tenants?slug=eq.${encodeURIComponent(user.resolved_tenant_slug)}&limit=1`
        );
        tenantId = tenantData?.[0]?.id || null;
      }
      if (!tenantId) {
        const tenantData = await supabaseQuery('tenants?order=created_at.asc&limit=1');
        tenantId = tenantData?.[0]?.id || null;
      }
    } catch (e) {
      // Fall through
    }

    if (!tenantId) {
      return res.status(500).json({ ok: false, error: 'NO_TENANT_AVAILABLE' });
    }

    // Get the requesting admin's user_id (from bearer token if available)
    const hostUserId = req.headers['x-admin-user-id'] as string || authUserId;

    // Create the onboarding live room
    const roomId = randomUUID();
    const startsAt = new Date(Date.now() + 30 * 60000); // 30 minutes from now

    const room = {
      id: roomId,
      tenant_id: tenantId,
      title: `Onboarding: ${displayName}`,
      description: `Personal onboarding session for ${displayName} (${user.email}). Welcome to Vitana! This is a 1:1 session to help you get started with the platform.`,
      topic_keys: ['onboarding', 'getting-started'],
      host_user_id: hostUserId,
      starts_at: startsAt.toISOString(),
      status: 'scheduled',
      room_name: `onboarding-${displayName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}`,
      room_slug: `onboarding-${roomId.slice(0, 8)}`,
    };

    const roomResult = await supabaseQuery('live_rooms', {
      method: 'POST',
      body: room,
    });

    // Create an invitation linking to this room
    const invitation = {
      id: randomUUID(),
      email: user.email,
      auth_user_id: authUserId,
      tenant_id: tenantId,
      invitation_type: 'live_room',
      status: 'sent',
      live_room_id: roomId,
      message: `Hi ${displayName}! We've set up a personal onboarding session for you. Join us to explore Vitana's features together!`,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    };

    await supabaseQuery('onboarding_invitations', {
      method: 'POST',
      body: invitation,
    });

    console.log(`[Signup Tracker] Onboarding room created: ${roomId} for ${user.email}`);

    return res.status(201).json({
      ok: true,
      room: roomResult?.[0] || room,
      invitation,
      join_url: `/live/${roomId}`,
    });
  } catch (err: any) {
    console.error('[Signup Tracker] create-onboarding-room error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /:authUserId/repair
 * Re-runs provisioning for a user who is stuck (has auth.users row but
 * missing app_users or user_tenants).
 */
router.post('/:authUserId/repair', async (req: Request, res: Response) => {
  try {
    const { authUserId } = req.params;
    const config = getSupabaseServiceClient();
    if (!config) {
      return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
    }

    // Get user from auth.users via Supabase Admin API
    const authResponse = await fetch(`${config.url}/auth/v1/admin/users/${authUserId}`, {
      headers: {
        'apikey': config.key,
        'Authorization': `Bearer ${config.key}`,
      },
    });

    if (!authResponse.ok) {
      return res.status(404).json({ ok: false, error: 'AUTH_USER_NOT_FOUND' });
    }

    const authUser = await authResponse.json() as {
      id: string;
      email: string;
      raw_user_meta_data?: Record<string, any>;
    };

    const email = authUser.email;
    const tenantSlug = authUser.raw_user_meta_data?.tenant_slug;
    const displayName = authUser.raw_user_meta_data?.display_name
      || authUser.raw_user_meta_data?.full_name
      || email.split('@')[0];

    // Resolve tenant
    let tenantId: string | null = null;
    if (tenantSlug) {
      const tenantData = await supabaseQuery(`tenants?slug=eq.${encodeURIComponent(tenantSlug)}&limit=1`);
      tenantId = tenantData?.[0]?.id || null;
    }
    if (!tenantId) {
      const tenantData = await supabaseQuery('tenants?order=created_at.asc&limit=1');
      tenantId = tenantData?.[0]?.id || null;
    }

    const repairs: string[] = [];

    // Check/create app_users
    const existingAppUser = await supabaseQuery(`app_users?user_id=eq.${authUserId}&limit=1`);
    if (!existingAppUser || existingAppUser.length === 0) {
      await supabaseQuery('app_users', {
        method: 'POST',
        body: {
          user_id: authUserId,
          email,
          display_name: displayName,
          tenant_id: tenantId,
        },
        headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
      });
      repairs.push('app_users created');
    } else {
      repairs.push('app_users already exists');
    }

    // Check/create user_tenants
    if (tenantId) {
      const existingTenant = await supabaseQuery(
        `user_tenants?user_id=eq.${authUserId}&tenant_id=eq.${tenantId}&limit=1`
      );
      if (!existingTenant || existingTenant.length === 0) {
        await supabaseQuery('user_tenants', {
          method: 'POST',
          body: {
            tenant_id: tenantId,
            user_id: authUserId,
            active_role: 'community',
            is_primary: true,
          },
          headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
        });
        repairs.push('user_tenants created');
      } else {
        repairs.push('user_tenants already exists');
      }
    }

    console.log(`[Signup Tracker] Repair completed for ${email}: ${repairs.join(', ')}`);

    return res.status(200).json({
      ok: true,
      auth_user_id: authUserId,
      email,
      repairs,
    });
  } catch (err: any) {
    console.error('[Signup Tracker] repair error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /invitations
 * List all onboarding invitations with their status.
 */
router.get('/invitations', async (req: Request, res: Response) => {
  try {
    const config = getSupabaseServiceClient();
    if (!config) {
      return res.status(500).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED' });
    }

    const status = (req.query.status as string) || '';
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);

    let queryPath = `onboarding_invitations?order=created_at.desc&limit=${limit}`;
    if (status) {
      queryPath += `&status=eq.${encodeURIComponent(status)}`;
    }

    const data = await supabaseQuery(queryPath);

    return res.status(200).json({
      ok: true,
      invitations: data || [],
      count: data?.length || 0,
    });
  } catch (err: any) {
    console.error('[Signup Tracker] invitations query error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /health
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'admin-signups',
    description: 'Signup Funnel Tracker & Abandoned Registration Recovery',
    timestamp: new Date().toISOString(),
  });
});

export default router;
