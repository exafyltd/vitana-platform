import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to protect all parameterized routes in this router.
// Note: All route files with path parameters should apply this middleware.
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ ok: true, data: { userId: req.params.userId } });
});

export default router;