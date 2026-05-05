import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to protect path-to-regexp against ReDoS
router.use(limitPathParams());

router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({ ok: false, error: 'no supabase' });
    return;
  }

  const { userId } = req.params;
  
  // Example dummy response for standard user schema
  res.json({ ok: true, data: { user_id: userId } });
});

export default router;