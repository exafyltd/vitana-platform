import { Router, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Apply mitigation to all routes within this router
router.use(limitPathParams());

router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.json({ ok: true, data: { userId: req.params.id } });
});

export default router;