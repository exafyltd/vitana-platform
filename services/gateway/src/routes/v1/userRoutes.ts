import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to protect against path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:userId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });
  
  return res.json({ 
    ok: true, 
    data: { 
      userId: req.params.userId,
      identity: req.identity 
    } 
  });
});

export default router;