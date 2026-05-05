import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

router.use(limitPathParams());

router.get('/:user_id', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }
  
  return res.json({ 
    ok: true, 
    data: { user_id: req.params.user_id } 
  });
});

export default router;