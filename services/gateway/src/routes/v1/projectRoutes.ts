import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId });
});

export default router;