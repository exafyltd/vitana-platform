import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router();

// Apply mitigation middleware to all routes containing path parameters
router.use(limitPathParams());

router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  return res.json({ ok: true, data: { user_id: req.params.userId } });
});

export default router;