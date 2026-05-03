import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams(5, 200));

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, name: 'Project Name' });
});

router.get('/:projectId/users/:userId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, userId: req.params.userId });
});

export default router;