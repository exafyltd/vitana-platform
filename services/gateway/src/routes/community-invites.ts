/**
 * VTID-04508 (Community Autopilot CA-7): personal invite links.
 *
 *   GET  /api/v1/invites/me        member: my reusable invite link
 *   GET  /api/v1/invites/:code     public: is this a valid invite, who sent it
 *   POST /api/v1/invites/claim     new member: attribute me to the inviter
 *
 * Rules and anti-abuse live in services/community-autopilot/invites.ts.
 */
import { Router, Request, Response } from 'express';
import { optionalAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();
const LOG_PREFIX = '[community-invites]';

router.use(optionalAuth);

async function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false } });
}

router.get('/me', async (req: Request, res: Response) => {
  const identity = (req as AuthenticatedRequest).identity;
  if (!identity?.user_id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const sb = await serviceClient();
  if (!sb) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  try {
    const { fetchExcludedTestServiceAccountIds } = await import('../lib/excluded-test-service-accounts');
    if ((await fetchExcludedTestServiceAccountIds(sb)).has(identity.user_id)) {
      return res.status(403).json({ ok: false, error: 'test_or_service_account' });
    }
    let tenantId = identity.tenant_id ?? null;
    if (!tenantId) {
      const { data } = await sb.from('user_tenants').select('tenant_id').eq('user_id', identity.user_id).eq('is_primary', true).limit(1);
      tenantId = (data as Array<{ tenant_id: string }> | null)?.[0]?.tenant_id ?? null;
    }
    if (!tenantId) return res.status(400).json({ ok: false, error: 'no_tenant' });
    const { getOrCreateInviteLink, isInviteRewardEnabled, inviteRewardCredits } = await import('../services/community-autopilot/invites');
    const link = await getOrCreateInviteLink(sb, identity.user_id, tenantId);
    if (!link) return res.status(500).json({ ok: false, error: 'link_failed' });
    return res.json({ ok: true, ...link, reward_credits: isInviteRewardEnabled() ? inviteRewardCredits() : 0 });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} /me failed:`, err?.message);
    return res.status(500).json({ ok: false, error: 'invite_link_failed' });
  }
});

router.post('/claim', async (req: Request, res: Response) => {
  const identity = (req as AuthenticatedRequest).identity;
  if (!identity?.user_id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toLowerCase() : '';
  if (!code) return res.status(400).json({ ok: false, error: 'code is required' });
  const sb = await serviceClient();
  if (!sb) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  try {
    const { claimInvite } = await import('../services/community-autopilot/invites');
    const outcome = await claimInvite(sb, identity.user_id, code, {
      getAuthUser: async (userId) => {
        const { data } = await sb.auth.admin.getUserById(userId);
        const u = data?.user;
        return u ? { created_at: u.created_at ?? null, email_confirmed_at: (u as any).email_confirmed_at ?? null } : null;
      },
    });
    if (outcome.status === 'attributed') {
      await emitOasisEvent({
        vtid: 'SYSTEM',
        type: (outcome.rewarded ? 'community_autopilot.invite.rewarded' : 'community_autopilot.invite.attributed') as any,
        source: 'community-autopilot',
        status: 'info',
        message: `Invite attributed${outcome.rewarded ? `, inviter credited ${outcome.credits}` : ''}`,
        payload: { referral_id: outcome.referral_id, referred_id: identity.user_id, rewarded: outcome.rewarded, reward_reason: outcome.reward_reason ?? null },
      }).catch(() => {});
    }
    return res.json({ ok: outcome.status === 'attributed' || outcome.status === 'already_attributed', ...outcome });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} /claim failed:`, err?.message);
    return res.status(500).json({ ok: false, error: 'claim_failed' });
  }
});

router.get('/:code', async (req: Request, res: Response) => {
  const sb = await serviceClient();
  if (!sb) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  try {
    const { lookupInvite } = await import('../services/community-autopilot/invites');
    const r = await lookupInvite(sb, String(req.params.code || '').toLowerCase());
    return res.status(r.ok ? 200 : 404).json(r.ok ? r : { ok: false, error: 'invite_not_found' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'lookup_failed' });
  }
});

export default router;
