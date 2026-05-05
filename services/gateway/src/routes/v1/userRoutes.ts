import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Mitigate Express path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:userId', requireAuth, (req: Request, res: Response) => {
  res.json({ ok: true, data: { userId: req.params.userId } });
});

export default router;