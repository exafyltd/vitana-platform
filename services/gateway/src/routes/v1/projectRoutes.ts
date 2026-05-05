import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limiting mitigation against path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  res.json({
    ok: true,
    data: {
      projectId: req.params.projectId
    }
  });
});

export default router;