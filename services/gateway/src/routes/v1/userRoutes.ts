import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply param limit middleware to all routes in this router
router.use(limitPathParams());

router.get('/:userId', requireAuth, (req: Request, res: Response): void => {
  res.json({ ok: true, data: { userId: req.params.userId } });
});

export default router;