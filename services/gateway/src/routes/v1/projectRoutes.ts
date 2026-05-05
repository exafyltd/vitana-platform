import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to protect all parameterized routes in this router.
// Note: All route files with path parameters should apply this middleware.
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ ok: true, data: { projectId: req.params.projectId } });
});

export default router;