import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Mitigate CVE-2024-3651 ReDoS vulnerability
router.use(limitPathParams());

router.get('/:userId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  const userId = req.identity?.user_id || req.params.userId;
  return res.json({ ok: true, data: { user_id: userId } });
});

export default router;