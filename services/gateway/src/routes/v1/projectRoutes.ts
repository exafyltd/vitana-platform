import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply path parameter limit middleware to mitigate ReDoS vulnerability
router.use(limitPathParams());

router.get('/:project_id', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  return res.json({
    ok: true,
    data: {
      project_id: req.params.project_id
    }
  });
});

export default router;