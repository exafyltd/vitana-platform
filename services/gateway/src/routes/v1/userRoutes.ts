import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

const UserParamsSchema = z.object({
  userId: z.string().min(1),
});

router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  const parsed = UserParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid parameters' });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  return res.json({ ok: true, data: { user_id: parsed.data.userId } });
});

export default router;