import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the middleware to abort execution before downstream route evaluation
// if the path segments are pathologically long.
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  return res.json({ ok: true, data: { projectId: req.params.projectId } });
});

export default router;