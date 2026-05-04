import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';

const router = Router();

// Apply path parameter limit middleware to mitigate ReDoS vulnerabilities
router.use(limitPathParams(5, 200));

router.get('/:user_id', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  const userId = req.params.user_id;

  return res.json({ 
    ok: true, 
    data: { 
      user_id: userId 
    } 
  });
});

export default router;