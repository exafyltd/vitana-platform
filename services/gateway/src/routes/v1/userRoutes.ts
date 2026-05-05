import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply param limits globally on all user routes to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  return res.json({ ok: true, data: { userId: req.params.userId } });
});

export default router;