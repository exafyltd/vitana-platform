import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limiting middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

router.get('/:projectId/members', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, members: [] });
});

export default router;