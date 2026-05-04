import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';

const router = Router();

// Apply param limiting to all routes utilizing path params
router.use(limitPathParams());

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  return res.json({ ok: true, data: { id: req.params.id } });
});

export default router;