import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams(5, 200));

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ project: req.params.projectId });
});

router.post('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.status(200).json({ project: req.params.projectId, member: req.params.memberId });
});

export default router;