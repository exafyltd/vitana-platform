import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limiting middleware to mitigate ReDoS vulnerabilities
router.use(limitPathParams());

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  // Implementation stub for user retrieval
  return res.json({ ok: true, data: { user_id: req.params.id } });
});

export default router;