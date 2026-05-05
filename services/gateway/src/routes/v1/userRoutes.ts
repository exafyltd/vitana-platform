import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply mitigation for path-to-regexp CVE ReDoS
router.use(limitPathParams());

router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { user_id: req.params.userId } });
});

export default router;