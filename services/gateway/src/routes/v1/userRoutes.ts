import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  return res.json({ ok: true, data: { userId: req.params.userId } });
});

export default router;