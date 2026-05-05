import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { getSupabase } from '../../lib/supabase';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Mitigate CVE-2024-3651 ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });

  return res.json({ ok: true, data: { project_id: req.params.projectId } });
});

export default router;