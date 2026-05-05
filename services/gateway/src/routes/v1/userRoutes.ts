import { Router, Request, Response } from 'express';
import { getSupabase } from '../../lib/supabase';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  return res.json({ ok: true, data: { id: req.params.id } });
});

export default router;