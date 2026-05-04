import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply mitigation for ReDoS by capping path parameter evaluation
router.use(limitPathParams());

router.get('/:userId', requireAuth, (req: Request, res: Response) => {
  return res.json({ ok: true, data: { userId: req.params.userId } });
});

export default router;