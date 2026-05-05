import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply CVE mitigation middleware to limit path parameters
router.use(limitPathParams());

router.get('/:userId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  const { userId } = req.params;
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }

  return res.json({ ok: true, data });
});

export default router;