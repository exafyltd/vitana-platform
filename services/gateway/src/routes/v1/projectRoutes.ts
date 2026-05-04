import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.projectId, type: 'project' });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, taskId: req.params.taskId });
});

export default router;