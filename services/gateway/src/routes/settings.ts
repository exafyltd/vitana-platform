import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { writeMemoryFact } from '../services/memory-facts';

const router = Router();

const ProfileUpdateSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  nickname: z.string().optional(),
});

router.patch('/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  const identity = req.identity;
  if (!identity || !identity.user_id) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const tenantId = identity.tenant_id;
  if (!tenantId) {
    return res.status(400).json({ ok: false, error: 'missing tenant_id' });
  }

  const parsed = ProfileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid payload', details: parsed.error.issues });
  }

  const { first_name, last_name, nickname } = parsed.data;

  if (first_name !== undefined) {
    const result = await writeMemoryFact(supabase, {
      userId: identity.user_id,
      tenantId,
      factKey: 'user_first_name',
      factValue: first_name,
      provenanceSource: 'user_stated_via_settings',
    });
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }
  }

  if (last_name !== undefined) {
    const result = await writeMemoryFact(supabase, {
      userId: identity.user_id,
      tenantId,
      factKey: 'user_last_name',
      factValue: last_name,
      provenanceSource: 'user_stated_via_settings',
    });
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }
  }

  if (nickname !== undefined) {
    const result = await writeMemoryFact(supabase, {
      userId: identity.user_id,
      tenantId,
      factKey: 'user_nickname',
      factValue: nickname,
      provenanceSource: 'user_stated_via_settings',
    });
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }
  }

  return res.json({ ok: true });
});

export default router;