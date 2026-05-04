import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';

const router = Router();

// Apply mitigation for ReDoS vulnerability in path-to-regexp
router.use(limitPathParams());

router.get('/:id', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  return res.json({ ok: true, data: { user_id: req.params.id } });
});

export default router;