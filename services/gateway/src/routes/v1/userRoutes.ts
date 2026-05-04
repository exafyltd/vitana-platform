import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router();

// Apply param-limiting mitigation against ReDoS to all endpoints in this router
router.use(limitPathParams(5, 200));

router.get('/:userId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  // Business logic for user retrieval would go here.
  // Returning parameterized success for validation context.
  return res.json({ 
    ok: true, 
    data: { 
      user_id: req.params.userId 
    } 
  });
});

export default router;