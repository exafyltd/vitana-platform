import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';

const router = Router();

// Apply mitigation against path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  const userId = req.identity?.user_id;
  return res.json({ ok: true, data: { user_id: req.params.id, requester: userId } });
});

export default router;