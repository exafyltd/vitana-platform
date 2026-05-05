import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { upsertMemoryFact } from '../services/memory-facts';
import { z } from 'zod';

const router = Router();

const profileUpdateSchema = z.object({
  firstName: z.string().optional(),
  nickname: z.string().optional()
});

router.patch('/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  if (!req.identity || !req.identity.user_id || !req.identity.tenant_id) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { user_id: userId, tenant_id: tenantId } = req.identity;

  const parsed = profileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid body' });
  }

  const { firstName, nickname } = parsed.data;

  if (firstName !== undefined) {
    const resFirstName = await upsertMemoryFact(supabase, {
      userId,
      tenantId,
      factType: 'user_first_name',
      factValue: firstName,
      provenanceSource: 'user_stated_via_settings'
    });
    if (!resFirstName.ok) {
      return res.status(500).json({ ok: false, error: resFirstName.error });
    }
  }

  if (nickname !== undefined) {
    const resNickname = await upsertMemoryFact(supabase, {
      userId,
      tenantId,
      factType: 'user_nickname',
      factValue: nickname,
      provenanceSource: 'user_stated_via_settings'
    });
    if (!resNickname.ok) {
      return res.status(500).json({ ok: false, error: resNickname.error });
    }
  }

  return res.json({ ok: true });
});

export default router;